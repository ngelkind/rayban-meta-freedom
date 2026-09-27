"""Lazy Android bridge support for standalone Frida host tools.

Frida 17 keeps Java support outside raw scripts.  The interactive CLI supplies
it on demand; these small helpers give our non-interactive capture tools the
same behaviour.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import frida_tools


JAVA_BRIDGE_BOOTSTRAP = r"""
"""


def source_with_java_bridge(source: str) -> str:
    """Bundle Frida's Java bridge before an agent script."""
    bridge_path = Path(frida_tools.__file__).parent / "bridges" / "java.js"
    bridge = bridge_path.read_text(encoding="utf-8")
    return (
        JAVA_BRIDGE_BOOTSTRAP
        + "\n"
        + bridge
        + "\nObject.defineProperty(globalThis, 'Java', { value: bridge });\n"
        + source
    )


def handle_bridge_request(message: dict[str, Any], script: Any) -> bool:
    """Reply to the agent's lazy Java-bridge request, if this is one."""
    if message.get("type") != "send":
        return False
    payload = message.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "frida:load-bridge":
        return False
    if payload.get("name") != "Java":
        return False

    path = Path(frida_tools.__file__).parent / "bridges" / "java.js"
    script.post({"type": "frida:bridge-loaded", "filename": path.name, "source": path.read_text(encoding="utf-8")})
    return True


def attach_target(device: Any, target: str) -> Any:
    """Attach by PID when Gadget exposes its process name instead of package."""
    for process in device.enumerate_processes():
        if process.name == target:
            return device.attach(process.pid)
    return device.attach(target)
