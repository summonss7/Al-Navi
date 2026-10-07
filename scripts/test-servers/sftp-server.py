# Local SFTP server for Al-Navi development and e2e tests (card alnavi-014).
# paramiko-based, password auth test/test, paths jailed under ROOT (default:
# sftp-root/ next to this file). The host key is generated once by OpenSSH
# ssh-keygen and cached next to this script.
# Usage: python scripts/test-servers/sftp-server.py [rootDir] [port]
# Prints "SFTP READY on 127.0.0.1:<port> root=<dir>" when listening.
import logging
import os
import socket
import sys

import paramiko
from paramiko import SFTPAttributes, SFTPHandle

# server-side SFTP exceptions land only in paramiko's DEBUG log — surface them
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "sftp-root")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 2222
KEY_PRIV = os.path.join(HERE, "sftp-hostkey")

os.makedirs(ROOT, exist_ok=True)

if os.path.exists(KEY_PRIV):
    host_key = paramiko.Ed25519Key.from_private_key_file(KEY_PRIV)
else:
    # paramiko 5.0 cannot generate ed25519 keys in-process — use OpenSSH
    import subprocess

    subprocess.run(
        ["C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe", "-t", "ed25519", "-N", "", "-f", KEY_PRIV, "-q"],
        check=True,
    )
    host_key = paramiko.Ed25519Key.from_private_key_file(KEY_PRIV)

def _jail(path):
    """map a client POSIX path into ROOT, resolving . and .. textually"""
    rel = (path or "/").replace("\\", "/").lstrip("/")
    parts = []
    for seg in rel.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return os.path.join(ROOT, *parts), "/" + "/".join(parts)


class JailFileHandle(SFTPHandle):
    def __init__(self, fd, flags=0):
        super().__init__(flags)
        self.fd = fd

    def read(self, offset, length):
        # no os.pread on Windows: the SFTP session is single-threaded, so an
        # explicit seek before each read/write is safe
        try:
            os.lseek(self.fd, offset, os.SEEK_SET)
            return os.read(self.fd, length)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def write(self, offset, data):
        try:
            os.lseek(self.fd, offset, os.SEEK_SET)
            n = os.write(self.fd, data)
            if n != len(data):
                return paramiko.SFTP_FAILURE
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass


class JailSI(paramiko.SFTPServerInterface):
    def canonicalize(self, path):
        return _jail(path)[1]

    def open(self, path, flags, attr):
        local = _jail(path)[0]
        try:
            fd = os.open(local, flags | getattr(os, "O_BINARY", 0))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)
        return JailFileHandle(fd, flags)

    def _attr(self, local, name=None):
        st = os.stat(local)
        a = SFTPAttributes()
        a.st_size = st.st_size
        a.st_uid = a.st_gid = 0
        a.st_mode = st.st_mode
        a.st_atime = int(st.st_atime)
        a.st_mtime = int(st.st_mtime)
        a.filename = name if name is not None else os.path.basename(local)
        return a

    def list_folder(self, path):
        local = _jail(path)[0]
        try:
            out = []
            with os.scandir(local) as it:
                for e in sorted(it, key=lambda x: x.name):
                    out.append(self._attr(os.path.join(local, e.name), e.name))
            return out
        except OSError as er:
            return paramiko.SFTPServer.convert_errno(er)

    def stat(self, path):
        local = _jail(path)[0]
        try:
            return self._attr(local)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def lstat(self, path):
        local = _jail(path)[0]
        try:
            st = os.lstat(local)
            a = SFTPAttributes()
            a.st_size = st.st_size
            a.st_uid = a.st_gid = 0
            a.st_mode = st.st_mode
            a.st_atime = int(st.st_atime)
            a.st_mtime = int(st.st_mtime)
            return a
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def remove(self, path):
        try:
            os.remove(_jail(path)[0])
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def rename(self, oldpath, newpath):
        try:
            os.replace(_jail(oldpath)[0], _jail(newpath)[0])
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def posix_rename(self, oldpath, newpath):
        return self.rename(oldpath, newpath)

    def mkdir(self, path, attr):
        try:
            os.mkdir(_jail(path)[0])
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def rmdir(self, path):
        try:
            os.rmdir(_jail(path)[0])
            return paramiko.SFTP_OK
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e)

    def chattr(self, path, attr):
        return paramiko.SFTP_OK

    def readlink(self, path):
        return paramiko.SFTP_OP_UNSUPPORTED

    def symlink(self, target_path, path):
        return paramiko.SFTP_OP_UNSUPPORTED


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        if (username, password) == ("test", "test"):
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", PORT))
sock.listen(16)
print(f"SFTP READY on 127.0.0.1:{PORT} root={ROOT}", flush=True)

while True:
    client, _addr = sock.accept()
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    transport.set_subsystem_handler("sftp", paramiko.SFTPServer, JailSI)
    server = Server()
    try:
        transport.start_server(server=server)
    except Exception as e:  # a broken handshake must not kill the server
        print(f"handshake error: {e}", file=sys.stderr, flush=True)
        transport.close()
        continue
