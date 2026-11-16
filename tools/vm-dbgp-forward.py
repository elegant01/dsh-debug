#!/usr/bin/env python3
"""Tiny TCP forwarder for dsh-debug: docker0:9004 -> 127.0.0.1:9003.

Why: the SSH reverse tunnel (-R 9003:127.0.0.1:9003) binds the VM's loopback
only, so docker containers cannot reach it. This forwarder re-publishes the
tunnel endpoint on docker0 (172.17.0.1) — visible to containers only, not to
the LAN. Stop with Ctrl-C; nothing is persisted.
"""
import socket
import threading

LISTEN = ("172.17.0.1", 9004)
TARGET = ("127.0.0.1", 9003)

def pipe(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        try: b.shutdown(socket.SHUT_WR)
        except OSError: pass

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(8)
    print(f"forwarding {LISTEN[0]}:{LISTEN[1]} -> {TARGET[0]}:{TARGET[1]}")
    while True:
        client, addr = srv.accept()
        try:
            upstream = socket.create_connection(TARGET, timeout=10)
        except OSError as e:
            print(f"upstream unreachable: {e}")
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()

if __name__ == "__main__":
    main()
