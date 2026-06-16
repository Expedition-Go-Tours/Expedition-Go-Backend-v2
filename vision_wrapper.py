\"\"\"Wrapper: fixes stdin buffering, then launches opencode-vision server.\"\"\"
import os, sys

# Force unbuffered stdin by patching before importing server
import opencode_vision.mcp as _mcp

_orig_recv = _mcp.recv

def _patched_recv():
    \"\"\"Fixed recv that reads from unbuffered os.read instead of BufferedReader.\"\"\"
    try:
        content_length = 0
        while True:
            line = _mcp._read_line()
            if not line:
                return None
            if not line.strip():
                break
            decoded = line.decode(\"utf-8\", errors=\"replace\")
            if decoded.lower().startswith(\"content-length:\"):
                content_length = int(decoded.split(\":\", 1)[1].strip())
        if content_length > 0:
            body = _mcp._read_exact(content_length)
            return __import__(\"json\").loads(body.decode(\"utf-8\"))
        return None
    except Exception as e:
        __import__(\"logging\").getLogger(__name__).error(\"mcp.recv error: %s\", e)
        return None

_mcp.recv = _patched_recv

from opencode_vision.server import main
main()
