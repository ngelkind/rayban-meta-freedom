#!/usr/bin/env python3
"""
scan_glasses.py — passive BLE scan from the Mac (CoreBluetooth via bleak).

Recon only: lists nearby BLE advertisers with their service UUIDs + manufacturer
data, highlighting likely Ray-Ban Meta candidates. The glasses use a rotating
resolvable private address (RPA) and, while bonded+connected to the phone, may
not advertise a connectable service — so "not seen" here is not conclusive.
Best run with the glasses OUT of the case and the phone's Bluetooth OFF (so the
glasses fall back to advertising).

Usage:  .venv/bin/python tools/driver/scan_glasses.py [seconds]
Harmless, read-only. Does NOT connect or pair.
"""
import asyncio, sys
from bleak import BleakScanner

# CONFIRMED from static RE (notes/protocol-transport.md):
#   advert carries manufacturer id 427 (0x01AB, Meta) + service 0xFD5F / 0xFEB8.
#   control pipe = GATT service 0xFD5F -> PSM char 05ACBE9F-... -> L2CAP CoC.
META_COMPANY_IDS = {427: "Meta (0x01AB)"}
GLASSES_SERVICE_UUIDS = {
    "0000fd5f-0000-1000-8000-00805f9b34fb": "Meta control (0xFD5F)",
    "0000feb8-0000-1000-8000-00805f9b34fb": "Meta legacy GATT (0xFEB8)",
}
PSM_CHAR_UUID = "05acbe9f-6f61-4ca9-80bf-c8bbb52991c0"  # read this for the L2CAP PSM

async def main(seconds: float):
    seen = {}
    def cb(dev, adv):
        seen[dev.address] = (dev, adv)
    scanner = BleakScanner(detection_callback=cb)
    print(f"[*] scanning {seconds:.0f}s (Ctrl-C to stop early)...")
    await scanner.start()
    try:
        await asyncio.sleep(seconds)
    finally:
        await scanner.stop()

    print(f"\n[*] {len(seen)} advertisers seen\n")
    for addr, (dev, adv) in sorted(seen.items(), key=lambda x: -(x[1][1].rssi or -999)):
        name = adv.local_name or dev.name or ""
        mfg = adv.manufacturer_data or {}
        svcs = adv.service_uuids or []
        flag = ""
        blob = " ".join(f"{cid:#06x}={data.hex()}" for cid, data in mfg.items())
        svcs_l = [str(u).lower() for u in svcs]
        if any(cid in META_COMPANY_IDS for cid in mfg) or \
           any(u in GLASSES_SERVICE_UUIDS for u in svcs_l) or \
           any(s in name.lower() for s in ("meta", "ray", "rb ")):
            flag = "  <<< META GLASSES CANDIDATE"
        print(f"{adv.rssi:>4} dBm  {addr}  {name!r}{flag}")
        if svcs:  print(f"            services: {svcs}")
        if blob:  print(f"            mfg: {blob}")

if __name__ == "__main__":
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
    try:
        asyncio.run(main(secs))
    except KeyboardInterrupt:
        pass
