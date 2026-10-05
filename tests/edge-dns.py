"""Exercise the generated split DNS config with isolated Cloudflare/router fixtures."""

import json
import pathlib
import subprocess
import sys
import tempfile
import time

import dns.exception
import dns.message
import dns.query
import dns.rcode
import dns.rdatatype


fixture = json.loads(pathlib.Path(sys.argv[1]).read_text())
zone = fixture["zone"]
private_name = f'{fixture["privateName"]}.{zone}'
port = 1053


def query(address, name, kind="A", tcp=False, timeout=2, source=None):
    message = dns.message.make_query(name, kind)
    exchange = dns.query.tcp if tcp else dns.query.udp
    return exchange(message, address, port=port, timeout=timeout, source=source)


def records(reply, kind, section="answer"):
    return [
        record.to_text()
        for rrset in getattr(reply, section)
        if rrset.rdtype == dns.rdatatype.from_text(kind)
        for record in rrset
    ]


def expect(address, name, kind, values, tcp=False):
    reply = query(address, name, kind, tcp=tcp)
    assert reply.rcode() == dns.rcode.NOERROR, reply.to_text()
    assert records(reply, kind) == values, reply.to_text()
    return reply


with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    log = root / "coredns.log"
    for view in ("lan", "tailnet"):
        (root / f"{view}.zone").write_text(fixture[f"{view}Zone"])

    # Substitute only transports/listen addresses: routing and zone data are production-generated.
    def write_corefile(corefile):
        corefile = corefile.replace(":53 {", f":{port} {{")
        corefile = corefile.replace("/etc/edge-dns/", f"{root}/")
        corefile = corefile.replace(f'bind {fixture["lanListenAddress"]}', "bind 127.0.0.1")
        corefile = corefile.replace(f'bind {fixture["tailnetListenAddress"]}', "bind 127.0.0.2")
        corefile = corefile.replace("1.1.1.1 1.0.0.1", f"127.0.0.3:{port} 127.0.0.6:{port}")
        corefile = corefile.replace(
            f'forward . {" ".join(fixture["upstreamResolvers"])}',
            f"forward . 127.0.0.4:{port}",
        )
        (root / "Corefile").write_text(corefile)

    write_corefile(fixture["corefile"])

    public_zone = f"""$ORIGIN {zone}.
@ 1 IN SOA public-ns.{zone}. hostmaster.{zone}. (1 60 60 60 1)
@ 60 IN NS public-ns.{zone}.
public-ns 60 IN A 203.0.113.53
@ 60 IN A 203.0.113.1
@ 60 IN AAAA 2001:db8::1
@ 60 IN MX 10 mail.{zone}.
@ 60 IN TXT "public-apex"
@ 60 IN HTTPS 1 . ipv4hint=203.0.113.1
link 60 IN CNAME public-target.{zone}.
public-target 60 IN A 203.0.113.20
{fixture["privateName"]} 60 IN A 203.0.113.99
{fixture["privateName"]} 60 IN AAAA 2001:db8::99
{fixture["privateName"]} 60 IN TXT "public-private-name"
{fixture["privateName"]} 60 IN HTTPS 1 . ipv4hint=203.0.113.99
_acme-challenge 60 IN TXT "public-challenge"
child.{fixture["privateName"]} 60 IN A 203.0.113.30
"""
    (root / "public.zone").write_text(public_zone)
    (root / "upstream.Corefile").write_text(f""".:{port} {{
  bind 127.0.0.3 127.0.0.6
  file {root}/public.zone {zone} {{
    reload 100ms
  }}
  errors
}}
.:{port} {{
  bind 127.0.0.4
  template IN A {{
    answer "{{{{ .Name }}}} 60 IN A 192.0.2.254"
  }}
  errors
}}
""")
    processes = []
    try:
        with log.open("w") as output:
            for filename in ("upstream.Corefile", "Corefile"):
                processes.append(subprocess.Popen(
                    ["coredns", "-conf", str(root / filename)],
                    stdout=output, stderr=subprocess.STDOUT,
                ))
            def wait_ready():
                deadline = time.monotonic() + 10
                while True:
                    assert all(p.poll() is None for p in processes), log.read_text()
                    try:
                        expect("127.0.0.1", private_name, "A", [fixture["lanAnswerAddress"]])
                        break
                    except dns.exception.Timeout:
                        assert time.monotonic() < deadline, log.read_text()

            wait_ready()

            for address, view in (("127.0.0.1", "lan"), ("127.0.0.2", "tailnet")):
                for tcp in (False, True):
                    expect(address, private_name.upper(), "A", [fixture[f"{view}AnswerAddress"]], tcp)
                    expect(address, zone, "A", [fixture[f"{view}AnswerAddress"]], tcp)
                    for kind in ("AAAA", "HTTPS", "SVCB", "TXT", "MX", "CNAME"):
                        expect(address, private_name, kind, [], tcp)
                    for kind in ("AAAA", "HTTPS", "SVCB", "CNAME"):
                        expect(address, zone, kind, [], tcp)
                    expect(address, f"link.{zone}", "CNAME", [f"public-target.{zone}."], tcp)
                    expect(address, f"link.{zone}", "A", ["203.0.113.20"], tcp)
                    expect(address, f"_acme-challenge.{zone}", "TXT", ['"public-challenge"'], tcp)
                    expect(address, f"child.{private_name}", "A", ["203.0.113.30"], tcp)
                    expect(address, zone, "MX", [f"10 mail.{zone}."], tcp)
                    expect(address, zone, "TXT", ['"public-apex"'], tcp)
                    expect(address, zone, "NS", [f"public-ns.{zone}."], tcp)
                    soa = query(address, zone, "SOA", tcp)
                    assert records(soa, "SOA")[0].startswith(f"public-ns.{zone}."), soa.to_text()
                    unknown = query(address, f"missing.{zone}", tcp=tcp)
                    assert unknown.rcode() == dns.rcode.NXDOMAIN, unknown.to_text()
                    assert records(unknown, "SOA", "authority")[0].startswith(f"public-ns.{zone}."), unknown.to_text()
                transfer = query(address, zone, "AXFR", tcp=True)
                assert transfer.rcode() == dns.rcode.REFUSED, transfer.to_text()

            expect("127.0.0.1", "example.net", "A", ["192.0.2.254"])

            # A new public record must appear without rebuilding or restarting the private resolver.
            for address in ("127.0.0.1", "127.0.0.2"):
                assert query(address, f"added.{zone}").rcode() == dns.rcode.NXDOMAIN
            (root / "public.zone").write_text(
                public_zone.replace("(1 60 60 60 1)", "(2 60 60 60 1)")
                + "added 60 IN A 203.0.113.40\n"
            )
            for address in ("127.0.0.1", "127.0.0.2"):
                deadline = time.monotonic() + 10
                while True:
                    reply = query(address, f"added.{zone}")
                    if records(reply, "A") == ["203.0.113.40"]:
                        break
                    assert time.monotonic() < deadline, reply.to_text()
                    time.sleep(0.1)

            processes[0].terminate()
            processes[0].wait(timeout=5)
            for address, view in (("127.0.0.1", "lan"), ("127.0.0.2", "tailnet")):
                offline_name = f'{fixture["offlinePrivateName"]}.{zone}'
                expect(address, offline_name, "A", [fixture[f"{view}AnswerAddress"]])
                expect(address, offline_name, "AAAA", [])
                expect(address, f"link.{zone}", "CNAME", [f"public-target.{zone}."])
                try:
                    reply = query(address, f"uncached-offline.{zone}", timeout=6)
                    assert reply.rcode() == dns.rcode.SERVFAIL, reply.to_text()
                except dns.exception.Timeout:
                    pass

            processes[0] = subprocess.Popen(
                ["coredns", "-conf", str(root / "upstream.Corefile")],
                stdout=output, stderr=subprocess.STDOUT,
            )
            for variant in ("rootless", "secondaries"):
                processes[1].terminate()
                processes[1].wait(timeout=5)
                for view in ("lan", "tailnet"):
                    field = f"rootless{view.capitalize()}Zone" if variant == "rootless" else f"{view}Zone"
                    (root / f"{view}.zone").write_text(fixture[field])
                write_corefile(fixture[f"{variant}Corefile"])
                processes[1] = subprocess.Popen(
                    ["coredns", "-conf", str(root / "Corefile")],
                    stdout=output, stderr=subprocess.STDOUT,
                )
                wait_ready()
                for address in ("127.0.0.1", "127.0.0.2"):
                    if variant == "rootless":
                        expect(address, zone, "A", ["203.0.113.1"])
                        expect(address, zone, "AAAA", ["2001:db8::1"])
                        expect(address, zone, "HTTPS", ['1 . ipv4hint="203.0.113.1"'])
                        expect(address, zone, "MX", [f"10 mail.{zone}."])
                        expect(address, zone, "TXT", ['"public-apex"'])
                    else:
                        public_soa = query(address, zone, "SOA")
                        local_soa = query(address, zone, "SOA", source="127.0.0.5")
                        assert records(public_soa, "SOA")[0].startswith(f"public-ns.{zone}."), public_soa.to_text()
                        assert records(local_soa, "SOA")[0].startswith(f"ns1.{zone}."), local_soa.to_text()
                        transferred = [
                            rrset
                            for reply in dns.query.xfr(address, zone, port=port, source="127.0.0.5", lifetime=5, relativize=False)
                            for rrset in reply.answer
                        ]
                        assert any(rrset.name.to_text() == f"{private_name}." for rrset in transferred)
                        assert not any(rrset.name.to_text() == f"link.{zone}." for rrset in transferred)
                        assert query(address, zone, "AXFR", tcp=True).rcode() == dns.rcode.REFUSED
        print("Split DNS passed: both views, UDP/TCP, private overrides, Cloudflare fallback, public updates and outages.")
    except BaseException:
        print(log.read_text(), file=sys.stderr)
        raise
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
