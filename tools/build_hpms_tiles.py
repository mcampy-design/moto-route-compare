#!/usr/bin/env python3
"""Build compact HPMS traffic tiles from the BTS HPMS file geodatabase.

Keeps only AADT, F_SYSTEM, the AADT year and geometry, simplifies lines to about 5 m, cuts them
into 0.1-degree tiles (each with a ~100 m margin so lookups near an edge still work) and writes
one gzipped binary file per tile. The tile layout is documented in hpms.js, which reads it.

Usage (from the repo root):
  python3 -m venv tools/.venv && tools/.venv/bin/pip install pyogrio shapely numpy
  curl -L -o tools/data/hpms_2024.gdb.zip \
    https://www.arcgis.com/sharing/rest/content/items/5e6a977c2d7c4ec1bdc82e684d3384f2/data
  tools/.venv/bin/python tools/build_hpms_tiles.py

Output goes to tools/out/tiles/hpms-<year>/<row>_<col>.bin.gz (row = floor(lat*10), col = floor(lon*10))
plus tools/out/meta.json. The hpms-<year> folder is the data version: hpms.js (DATA_VERSION) must match it. Everything under tools/data and tools/out is git-ignored.
"""
import argparse
import gzip
import json
import os
import struct
import sys
import time
from collections import defaultdict

import numpy as np
import pyogrio.raw as ogr
import shapely

STATES = "AL CT DE DC FL GA IL IN KY ME MD MA MI MS NH NJ NY NC OH PA RI SC TN VT VA WV WI".split()
# States the source release flags as missing large parts of their data (README_2024_HPMS_All.md).
KNOWN_INCOMPLETE = ["NJ"]

TILE_DEG = 0.1
MARGIN = 0.001
SPAN = TILE_DEG + 2 * MARGIN
UNIT = SPAN / 65535
MAGIC = b"HPT1"
HEADER = 16
SPILL_HEAD = struct.Struct("<HHIBBH")  # minY, maxY, aadt, fsystem, aadtYear, nPts


def tile_rect(row, col):
    return col / 10 - MARGIN, row / 10 - MARGIN, (col + 1) / 10 + MARGIN, (row + 1) / 10 + MARGIN


def quantize(coords, row, col):
    x0, y0 = col / 10 - MARGIN, row / 10 - MARGIN
    q = np.empty((len(coords), 2), dtype=np.uint16)
    q[:, 0] = np.clip(np.rint((coords[:, 0] - x0) / UNIT), 0, 65535)
    q[:, 1] = np.clip(np.rint((coords[:, 1] - y0) / UNIT), 0, 65535)
    return q


def pieces(geom, row, col, bbox):
    """The part of one line that falls in a tile's padded rectangle, as coordinate arrays."""
    x0, y0, x1, y1 = tile_rect(row, col)
    if bbox[0] >= x0 and bbox[1] >= y0 and bbox[2] <= x1 and bbox[3] <= y1:
        return [shapely.get_coordinates(geom)]
    clipped = shapely.clip_by_rect(geom, x0, y0, x1, y1)
    out = []
    for part in shapely.get_parts(clipped):
        if part.geom_type == "LineString" and len(part.coords) >= 2:
            out.append(shapely.get_coordinates(part))
    return out


def spill_record(coords, row, col, aadt, fsystem, year):
    q = quantize(coords, row, col)
    return SPILL_HEAD.pack(int(q[:, 1].min()), int(q[:, 1].max()), aadt, fsystem, year, len(q)) + q.astype("<u2").tobytes()


def process_state(path, state, tol_deg, spill):
    layer = f"HPMS_FULL_{state}_2024"
    meta, _, wkb, vals = ogr.read(path, layer=layer, columns=["aadt", "aadt_vd", "f_system"])
    col = dict(zip(meta["fields"], vals))
    geoms = shapely.from_wkb(wkb)
    geoms = shapely.force_2d(geoms)
    parts, src = shapely.get_parts(geoms, return_index=True)
    keep = ~shapely.is_empty(parts)
    parts, src = parts[keep], src[keep]
    parts = shapely.simplify(parts, tol_deg, preserve_topology=False)
    keep = ~shapely.is_empty(parts)
    parts, src = parts[keep], src[keep]

    aadt_all = np.nan_to_num(col["aadt"], nan=0).clip(0, 4_294_967_295).astype(np.uint32)
    fsys_all = np.where((col["f_system"] >= 1) & (col["f_system"] <= 7), col["f_system"], 0).astype(np.uint8)
    yrs = col["aadt_vd"].astype("datetime64[Y]").astype(float)  # NaT -> nan
    yr_all = np.where(np.isnan(yrs), 0, np.clip(yrs + 1970 - 2000, 0, 255)).astype(np.uint8)
    year_record = int(np.max(col.get("data_year", np.array([2024])))) if "data_year" in col else 2024

    bounds = shapely.bounds(parts)
    r0 = np.floor((bounds[:, 1] - MARGIN) * 10).astype(int)
    r1 = np.floor((bounds[:, 3] + MARGIN) * 10).astype(int)
    c0 = np.floor((bounds[:, 0] - MARGIN) * 10).astype(int)
    c1 = np.floor((bounds[:, 2] + MARGIN) * 10).astype(int)

    for i in range(len(parts)):
        s = src[i]
        a, f, y = int(aadt_all[s]), int(fsys_all[s]), int(yr_all[s])
        for row in range(r0[i], r1[i] + 1):
            for c in range(c0[i], c1[i] + 1):
                for coords in pieces(parts[i], row, c, bounds[i]):
                    spill[(row, c)].append(spill_record(coords, row, c, a, f, y))
    return len(parts), year_record


def write_tile(row, col, records, year, out_dir):
    heads = [SPILL_HEAD.unpack_from(r) for r in records]
    order = sorted(range(len(records)), key=lambda i: heads[i][0])
    n = len(order)
    max_h = max(h[1] - h[0] for h in heads)
    body = bytearray()
    offsets = []
    base = HEADER + n * 2 + n * 4
    for i in order:
        offsets.append(base + len(body))
        _, _, aadt, fsys, yr, npts = heads[i]
        body += struct.pack("<IBBH", aadt, fsys, yr, npts) + records[i][SPILL_HEAD.size:]
    blob = bytearray(MAGIC)
    blob += struct.pack("<HHII", year, min(max_h, 65535), n, 0)
    blob += np.array([heads[i][0] for i in order], dtype="<u2").tobytes()
    blob += np.array(offsets, dtype="<u4").tobytes()
    blob += body
    path = os.path.join(out_dir, f"hpms-{year}", f"{row}_{col}.bin.gz")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        # mtime=0 keeps rebuilds byte-identical
        fh.write(gzip.compress(bytes(blob), compresslevel=9, mtime=0))
    return os.path.getsize(path), len(blob), n


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gdb", default=os.path.join(root, "data", "hpms_2024.gdb.zip"))
    ap.add_argument("--out", default=os.path.join(root, "out", "tiles"))
    ap.add_argument("--states", nargs="*", default=STATES)
    ap.add_argument("--tolerance-m", type=float, default=5.0, help="line simplification tolerance in metres")
    args = ap.parse_args()

    path = args.gdb if args.gdb.startswith("/vsi") else ("/vsizip/" + os.path.abspath(args.gdb) if args.gdb.endswith(".zip") else args.gdb)
    tol_deg = args.tolerance_m / 111320
    spill = defaultdict(list)
    year, counts = 2024, {}
    t0 = time.time()
    for st in args.states:
        n, year = process_state(path, st, tol_deg, spill)
        counts[st] = n
        print(f"{st}: {n:>8} segments  ({len(spill)} tiles so far, {time.time() - t0:.0f}s)", flush=True)

    sizes = []
    for (row, col), recs in spill.items():
        sizes.append(write_tile(row, col, recs, year, args.out))
    gz = [s[0] for s in sizes]
    meta = {
        "source": "FHWA HPMS 2024 via BTS NTAD file geodatabase",
        "year": year,
        "states": args.states,
        "incompleteStates": [s for s in KNOWN_INCOMPLETE if s in args.states],
        "tolerance_m": args.tolerance_m,
        "tiles": len(sizes),
        "segments": sum(s[2] for s in sizes),
        "totalBytesGzip": sum(gz),
        "tileBytesGzipMin": min(gz), "tileBytesGzipMedian": int(np.median(gz)), "tileBytesGzipMax": max(gz),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    hpms_js = open(os.path.join(root, "..", "hpms.js")).read()
    if f"DATA_VERSION = 'hpms-{year}'" not in hpms_js:
        print(f"WARNING: set DATA_VERSION to 'hpms-{year}' in hpms.js, or the page will look for the wrong tile path.", file=sys.stderr)
    with open(os.path.join(os.path.dirname(args.out), "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    sys.exit(main())
