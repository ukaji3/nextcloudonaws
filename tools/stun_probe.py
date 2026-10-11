#!/usr/bin/env python3
"""Check that a TURN/STUN server answers a STUN Binding Request over UDP and TCP.

Usage:
    python3 tools/stun_probe.py turn.<domain> [port]

Prints one line per transport, e.g.
``turn.example.com:3478/udp -> BINDING SUCCESS mapped=203.0.113.10:51234``.
Exits with status 1 when any transport fails. Only the standard library is used.
"""

import os
import socket
import struct
import sys

MAGIC_COOKIE = 0x2112A442
BINDING_REQUEST = 0x0001
BINDING_SUCCESS = 0x0101
XOR_MAPPED_ADDRESS = 0x0020
HEADER_LENGTH = 20
UDP_ATTEMPTS = 3
TIMEOUT_SECONDS = 3.0


def build_request(transaction_id: bytes) -> bytes:
    """Build a STUN Binding Request (RFC 5389) without attributes.

    Args:
        transaction_id: 12 random bytes identifying the transaction.

    Returns:
        The encoded request.
    """
    return struct.pack("!HHI", BINDING_REQUEST, 0, MAGIC_COOKIE) + transaction_id


def decode_xor_mapped_address(value: bytes) -> str:
    """Decode an IPv4 XOR-MAPPED-ADDRESS attribute value.

    Args:
        value: Attribute value (at least 8 bytes).

    Returns:
        ``ip:port`` of the reflexive address.
    """
    port = struct.unpack("!H", value[2:4])[0] ^ (MAGIC_COOKIE >> 16)
    address = struct.unpack("!I", value[4:8])[0] ^ MAGIC_COOKIE
    return f"{socket.inet_ntoa(struct.pack('!I', address))}:{port}"


def parse_response(data: bytes, transaction_id: bytes) -> str:
    """Interpret a STUN response.

    Args:
        data: Raw response.
        transaction_id: Transaction ID of the request.

    Returns:
        ``BINDING SUCCESS mapped=ip:port`` or a short failure description.
    """
    if len(data) < HEADER_LENGTH:
        return "short response"
    message_type, length, cookie = struct.unpack("!HHI", data[:8])
    if cookie != MAGIC_COOKIE or data[8:HEADER_LENGTH] != transaction_id:
        return "unexpected response"
    if message_type != BINDING_SUCCESS:
        return f"non-success message type 0x{message_type:04x}"
    position = HEADER_LENGTH
    while position + 4 <= HEADER_LENGTH + length:
        attribute, size = struct.unpack("!HH", data[position:position + 4])
        value = data[position + 4:position + 4 + size]
        if attribute == XOR_MAPPED_ADDRESS and size >= 8:
            return f"BINDING SUCCESS mapped={decode_xor_mapped_address(value)}"
        position += 4 + size + (-size % 4)
    return "success without XOR-MAPPED-ADDRESS"


def probe_udp(host: str, port: int) -> str:
    """Send the request over UDP, retrying on timeout.

    Args:
        host: Server host name.
        port: Server port.

    Returns:
        Result description.
    """
    transaction_id = os.urandom(12)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(TIMEOUT_SECONDS)
        for _ in range(UDP_ATTEMPTS):
            sock.sendto(build_request(transaction_id), (host, port))
            try:
                return parse_response(sock.recvfrom(2048)[0], transaction_id)
            except TimeoutError:
                continue
    return "TIMEOUT"


def probe_tcp(host: str, port: int) -> str:
    """Send the request over TCP.

    Args:
        host: Server host name.
        port: Server port.

    Returns:
        Result description.
    """
    transaction_id = os.urandom(12)
    with socket.create_connection((host, port), timeout=TIMEOUT_SECONDS) as sock:
        sock.settimeout(TIMEOUT_SECONDS)
        sock.sendall(build_request(transaction_id))
        return parse_response(sock.recv(2048), transaction_id)


def probe(host: str, port: int, transport: str) -> str:
    """Run one probe and turn network errors into a result description.

    Args:
        host: Server host name.
        port: Server port.
        transport: ``udp`` or ``tcp``.

    Returns:
        Result description.
    """
    try:
        return probe_udp(host, port) if transport == "udp" else probe_tcp(host, port)
    except OSError as error:
        return f"ERROR {type(error).__name__}: {error}"


def main(argv: list[str]) -> int:
    """Probe UDP and TCP and report the results.

    Args:
        argv: Command line arguments (host, optional port).

    Returns:
        0 when both transports succeed, 1 otherwise.
    """
    if len(argv) < 2:
        print(__doc__)
        return 2
    host = argv[1]
    port = int(argv[2]) if len(argv) > 2 else 3478
    failed = False
    for transport in ("udp", "tcp"):
        result = probe(host, port, transport)
        failed = failed or not result.startswith("BINDING SUCCESS")
        print(f"{host}:{port}/{transport} -> {result}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
