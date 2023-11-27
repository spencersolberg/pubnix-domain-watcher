import { load } from "https://deno.land/std@0.207.0/dotenv/mod.ts";
const env = await load();

const watcher = Deno.watchFs("/home");
const domainRegex = /^\/home\/[^/]*\/.domain$/

const createDomain = async (path: string) => {
    const domain = path.split("/")[2];
    console.log("Creating domain", domain);

    try {
        const TlsaRecord = await generateCertificates(domain);
        await createZoneFile(domain, TlsaRecord);
    
        const keyFile = await generateDnssecKey(domain);
        await generateCorefile(domain, keyFile);
        const DsRecord = await generateDsRecord(domain, keyFile);
    
        await restartCoreDns();

        const message = `
Domain ${domain} added successfully!

Configure your domain to use pubnix/ as the nameserver (Bob Wallet, Shakestation, Namebase):
NS: ${env.NS}
DS: ${DsRecord}

or, using your own nameservers configure the following records (Varo, Namebase):
A: ${domain}. ${env.A}
AAAA: ${domain}. ${env.AAAA}
TLSA: _443._tcp.${domain}. ${TlsaRecord}
        `;

        await Deno.writeTextFile(path, message);
    } catch (e) {
        console.error(e);

        await Deno.writeTextFile(path, `Error: ${e.message}`)
    }


}

const generateCertificates = async (domain: string): Promise<string> => {
    console.log("Generating certificates...")
    const cmd = new Deno.Command("bash", { args: [ "certificates.sh" ], env: { DOMAIN: domain } });
    const { code, stdout, stderr } = await cmd.output();

    if (code !== 0) {
        throw new Error(`Failed to generate certificates: ${new TextDecoder().decode(stderr)}`);
    }

    console.log("Generating TLSA record...")
    const cmd2 = new Deno.Command("bash", { args: [ "tlsa.sh" ], env: { DOMAIN: domain } });
    const { code: code2, stdout: stdout2, stderr: stderr2 } = await cmd2.output();

    if (code2 !== 0) {
        throw new Error(`Failed to generate TLSA record: ${new TextDecoder().decode(stderr2)}`);
    }

    return new TextDecoder().decode(stdout2).trim();
}

const createZoneFile = async (domain: string, TlsaRecord: string): Promise<void> => {
    console.log("Creating zone file...")
    const zoneFile = `
$TTL 3600
@ IN SOA  ns1.pubnix. ${domain}.pubnix. (
	  2023010101 ; serial
	  3600       ; refresh (1 hour)
	  1800       ; retry (30 minutes)
	  604800     ; expire (1 week)
	  3600       ; minimum (1 hour)
	  )
  IN NS   ns1.pubnix.
  IN A    64.176.193.64
  IN AAAA 2001:19f0:1000:14d0:5400:04ff:fea8:cbd0

_443._tcp IN TLSA ${TlsaRecord}
    `;
    await Deno.writeTextFile(`/etc/coredns/zones/db.${domain}`, zoneFile);
}

const generateDnssecKey = async (domain: string): Promise<string> => {
    console.log("Generating DNSSEC key...")
    const cmd = new Deno.Command("dnssec-keygen", { args: [ "-a", "ECDSAP256SHA256", "-K", "/etc/coredns/keys", domain ]});
    const { code, stdout, stderr } = await cmd.output();

    if (code !== 0) {
        throw new Error(`Failed to generate DNSSEC key: ${new TextDecoder().decode(stderr)}`);
    }

    const keyFile = new TextDecoder().decode(stdout).trim();
    console.log({ keyFile });
    return keyFile;
}

const generateCorefile = async (domain: string, keyFile: string): Promise<void> => {
    console.log("Generating Corefile...")
    const corefile = `
${domain} {
    file zones/db.${domain}
    dnssec {
        key file keys/${keyFile}
    }
}
    `;

    await Deno.writeTextFile(`/etc/coredns/corefiles/${domain}.Corefile`, corefile);
}

const generateDsRecord = async (domain: string, keyFile: string): Promise<string> => {
    console.log("Generating DS record...")
    const cmd = new Deno.Command("dnssec-dsfromkey", { args: [ "-a", "SHA-256", `/etc/coredns/keys/${keyFile}.key` ]});
    const { code, stdout, stderr } = await cmd.output();

    if (code !== 0) {
        throw new Error(`Failed to generate DS record: ${new TextDecoder().decode(stderr)}`);
    }

    const dsRecord = (new TextDecoder().decode(stdout)).replace(`${domain}. IN DS `, "").trim();

    return dsRecord;
}

const restartCoreDns = async (): Promise<void> => {
    console.log("Restarting CoreDNS...")
    const cmd = new Deno.Command("systemctl", { args: ["restart", "coredns"] });
    const { code, stdout, stderr } = await cmd.output();

    if (code !== 0) {
        throw new Error(`Failed to restart CoreDNS: ${new TextDecoder().decode(stderr)}`);
    }
}


for await (const event of watcher) {
    if (event.kind === "create") {
        for (const path of event.paths) {
            if (domainRegex.test(path)) {
                await createDomain(path);

                await Deno.remove(path);
            }
        }
    }
}
