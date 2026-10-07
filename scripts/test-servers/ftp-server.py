# Local FTP server for Al-Navi e2e regressions of the FTP code paths
# (pyftpdlib, user test/test, serves ROOT). Usage:
#   python scripts/test-servers/ftp-server.py [rootDir] [port]
# Prints "FTP READY on 127.0.0.1:<port> root=<dir>" when listening.
import os
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "ftp-root")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 2211

os.makedirs(ROOT, exist_ok=True)

authorizer = DummyAuthorizer()
authorizer.add_user("test", "test", ROOT, perm="elradfmwMT")
handler = FTPHandler
handler.authorizer = authorizer
# MLSD is what Al-Navi prefers for listings
handler.mlsd_enable = True
handler.passive_ports = range(60000, 60100)

server = FTPServer(("127.0.0.1", PORT), handler)
print(f"FTP READY on 127.0.0.1:{PORT} root={ROOT}", flush=True)
server.serve_forever()
