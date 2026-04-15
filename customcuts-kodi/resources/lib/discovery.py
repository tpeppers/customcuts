"""LAN discovery for the CustomCuts streaming host.

Sends a UDP broadcast of 'CC?' to port 8788 and waits for a reply of
the form 'CC!http://<ip>:<port>|<token>'. Matches the Roku channel's
DiscoveryTask and the phone-pairing fragment format.
"""
import socket
import time


DISCOVERY_PORT = 8788


def discover(timeout_ms=3000):
    """Broadcast CC? and wait for CC!... reply. Returns (host_url, token, error)."""
    timeout_s = max(0.5, timeout_ms / 1000.0)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except Exception:
        pass
    try:
        sock.bind(('0.0.0.0', 0))
    except Exception as e:
        try: sock.close()
        except Exception: pass
        return None, None, f'bind failed: {e}'
    sock.settimeout(0.3)

    try:
        sock.sendto(b'CC?', ('255.255.255.255', DISCOVERY_PORT))
    except Exception as e:
        try: sock.close()
        except Exception: pass
        return None, None, f'broadcast failed: {e}'

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            data, _addr = sock.recvfrom(1024)
        except socket.timeout:
            continue
        except Exception:
            break
        if not data or not data.startswith(b'CC!'):
            continue
        payload = data[3:].decode('utf-8', errors='ignore').strip()
        if '|' in payload:
            url, token = payload.split('|', 1)
        else:
            url, token = payload, ''
        try: sock.close()
        except Exception: pass
        return url, token, None

    try: sock.close()
    except Exception: pass
    return None, None, 'timeout'
