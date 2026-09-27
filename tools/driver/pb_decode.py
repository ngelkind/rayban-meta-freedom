#!/usr/bin/env python3
"""
pb_decode.py — generic protobuf wire-format decoder (no .proto needed).

Turns the hex payloads captured by tools/frida/datax-capture.js into structured
fields so we can reverse the DataX message schemas empirically.

Usage:
  echo 08 7b 12 03 61 62 63 | .venv/bin/python tools/driver/pb_decode.py
  .venv/bin/python tools/driver/pb_decode.py 087b1203616263
  # or pipe a capture log; it extracts 'payload=<hex>' tokens and decodes each.
"""
import sys, re

WT = {0: "varint", 1: "i64", 2: "len", 5: "i32"}

def _varint(b, i):
    shift = 0; val = 0
    while True:
        x = b[i]; i += 1
        val |= (x & 0x7f) << shift
        if not (x & 0x80): break
        shift += 7
    return val, i

def decode(b, depth=0, out=None):
    out = out if out is not None else []
    i = 0; ind = "  " * depth
    while i < len(b):
        try:
            key, i = _varint(b, i)
        except IndexError:
            break
        fnum = key >> 3; wt = key & 7
        if wt == 0:
            v, i = _varint(b, i)
            # show signed + zigzag interpretations for varints
            zz = (v >> 1) ^ -(v & 1)
            out.append(f"{ind}#{fnum} varint = {v}" + (f" (zigzag {zz})" if v > 1 else ""))
        elif wt == 1:
            v = int.from_bytes(b[i:i+8], "little"); i += 8
            out.append(f"{ind}#{fnum} i64 = 0x{v:016x} ({v})")
        elif wt == 5:
            v = int.from_bytes(b[i:i+4], "little"); i += 4
            out.append(f"{ind}#{fnum} i32 = 0x{v:08x} ({v})")
        elif wt == 2:
            ln, i = _varint(b, i)
            chunk = b[i:i+ln]; i += ln
            # Order: printable text first (common for ids/names), then submessage,
            # then raw hex. Heuristic — protobuf wire format is ambiguous.
            txt = _as_text(chunk, strict=True)
            if txt is not None:
                out.append(f"{ind}#{fnum} len[{ln}] = {txt}")
            else:
                sub = _try_submessage(chunk, depth + 1)
                if sub is not None:
                    out.append(f"{ind}#{fnum} len[{ln}] = message {{")
                    out.extend(sub)
                    out.append(f"{ind}}}")
                else:
                    out.append(f"{ind}#{fnum} len[{ln}] = bytes {chunk.hex()}")
        else:
            out.append(f"{ind}#{fnum} wire={wt} (unknown, stop) rest={b[i:].hex()}")
            break
    return out

def _try_submessage(chunk, depth):
    if not chunk:
        return None
    try:
        sub = decode(chunk, depth)
        # only accept recursion if it consumed cleanly and looked message-like
        if sub and not any("unknown, stop" in s for s in sub):
            return sub
    except Exception:
        pass
    return None

def _as_text(chunk, strict=False):
    if len(chunk) < (2 if strict else 1):
        return None if strict else f"bytes {chunk.hex()}"
    try:
        s = chunk.decode("utf-8")
        if s.isprintable() and all(32 <= ord(c) < 127 or c in "\t" for c in s):
            return f'"{s}"'
    except Exception:
        pass
    return None if strict else f"bytes {chunk.hex()}"

def _hex_to_bytes(s):
    s = re.sub(r"[^0-9a-fA-F]", "", s)
    if len(s) % 2: s = s[:-1]
    return bytes.fromhex(s)

def main():
    args = " ".join(sys.argv[1:]).strip()
    data = args if args else sys.stdin.read()
    # If it looks like a capture log, pull every payload=<hex> token
    payloads = re.findall(r"payload=([0-9a-fA-F]+)", data)
    if payloads:
        for p in payloads:
            print(f"--- payload {p[:24]}{'…' if len(p) > 24 else ''} ---")
            for line in decode(_hex_to_bytes(p)):
                print(line)
            print()
    else:
        for line in decode(_hex_to_bytes(data)):
            print(line)

if __name__ == "__main__":
    main()
