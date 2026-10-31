#!/bin/sh
# Install root-owned at /usr/local/libexec/scoville-desktop-input-drain.
# Fixed read-only X11 roundtrip on the existing dedicated display. No input,
# profile/cookie reads, arbitrary arguments, new display, or desktop restart.
set -eu
cd /tmp
exec /usr/bin/sudo -n -u agent-container /usr/bin/env HOME=/var/lib/agent-container XDG_RUNTIME_DIR=/run/user/1002 /usr/bin/podman exec -i agent-desktop-minimal /usr/bin/timeout --kill-after=1s 1s /usr/bin/python3 - <<'PY'
import os, ctypes
os.environ['HOME'] = '/nonexistent/scoville-drain'
os.environ['XAUTHORITY'] = '/nonexistent/scoville-drain'
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
display = x.XOpenDisplay(b'unix/:1')
if not display:
    raise SystemExit(1)
x.XSync(display, 0)
x.XCloseDisplay(display)
print('SCOVILLE_INPUT_DRAINED')
PY
