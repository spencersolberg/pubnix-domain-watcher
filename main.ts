import { load } from "std/dotenv/mod.ts";
import { expandGlob } from "std/fs/mod.ts";

const env = await load();

const watcher = Deno.watchFs("/home");
const domainRegex = /^\/home\/[^/]*\/.domain$/
const removeDomainRegex = /^\/home\/[^/]*\/.remove-domain$/

const createDomain = async (path: string) => {
    const domain = path.split("/")[2];
    console.log("Creating domain", domain);

    try {
        const TlsaRecord = await generateCertificates(domain);
        await createZoneFile(domain, TlsaRecord);
    
        const keyFile = await generateDnssecKey(domain);
        await generateCorefile(domain, keyFile);
        const DsRecord = await generateDsRecord(domain, keyFile);
        await generateCaddyFile(domain);
    
        await restartCoreDns();
        await reloadCaddy();

        const message = `
Domain ${domain} added successfully!

Configure your domain to use pubnix/ as the nameserver (Bob Wallet, Shakestation, Namebase):
NS: ${env.NS}
DS: ${DsRecord}

or, using your own nameservers configure the following records (Varo, Namebase):
A: ${domain}. ${env.A}
AAAA: ${domain}. ${env.AAAA}
TLSA: _443._tcp.${domain}. ${TlsaRecord}

You can remove the domain with the following command (run from your home directory):
touch .remove-domain
        `;

        await Deno.writeTextFile(path, message);
        console.log("Done!");
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
  IN A    ${env.A}
  IN AAAA ${env.AAAA}

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
    return keyFile;
}

const generateCorefile = async (domain: string, keyFile: string): Promise<void> => {
    console.log("Generating Corefile...")
    const corefile = `
${domain} {
    bind enp1s0
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

const generateCaddyFile = async (domain: string): Promise<void> => {
    console.log("Generating Caddyfile...")
    const caddyfile = `
${domain} {
    root * /home/${domain}/public_html
    file_server

    tls /etc/ssl/certs/${domain}.crt /etc/ssl/private/${domain}.key
}
    `;

    await Deno.writeTextFile(`/etc/caddy/caddyfiles/${domain}.Caddyfile`, caddyfile);

    const cmd = new Deno.Command("caddy", { args: [ "validate", "-c", `/etc/caddy/caddyfiles/${domain}.Caddyfile`, "-a", "caddyfile" ]});
    const { code, stdout, stderr } = await cmd.output();

    if (code !==0) {
        await Deno.remove(`/etc/caddy/caddyfiles/${domain}.Caddyfile`);
        throw new Error(`Failed to validate Caddyfile: ${new TextDecoder().decode(stderr)}`);
    }
}

const reloadCaddy = async (): Promise<void> => {
    console.log("Reloading Caddy...")
    const cmd = new Deno.Command("systemctl", { args: ["reload", "caddy"] });
    const { code, stdout, stderr } = await cmd.output();

    if (code !== 0) {
        throw new Error(`Failed to reload Caddy: ${new TextDecoder().decode(stderr)}`);
    }
}

const removeDomain = async (path: string): Promise<void> => {
    const domain = path.split("/")[2];
    console.log("Removing domain", domain);

    try {
        await removeCertificates(domain);
        await removeZoneFile(domain);
        await removeDnssecKey(domain);
        await removeCorefile(domain);
        await removeCaddyfile(domain);

        await restartCoreDns();
        await reloadCaddy();

        await Deno.remove(path);
        console.log("Done!");
    } catch (e) {
        console.error(e);
        await Deno.writeTextFile(path, `Error: ${e.message}`);
    }
}

const removeCertificates = async (domain: string): Promise<void> => {
    console.log("Removing certificates...")
    try {
        await Deno.remove(`/etc/ssl/certs/${domain}.crt`);
        await Deno.remove(`/etc/ssl/private/${domain}.key`);
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            throw e;
        }
    }

}

const removeZoneFile = async (domain: string): Promise<void> => {
    console.log("Removing zone file...")
    try {
        await Deno.remove(`/etc/coredns/zones/db.${domain}`);
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            throw e;
        }
    }
}

const removeDnssecKey = async (domain: string): Promise<void> => {
    // keys are stored as /etc/coredns/keys/K${domain}.+013+XXXXX where XXXXX is a randomly generated numerical 5 digit ID. There's a .key file and a .private, same name, different extension.
    console.log("Removing DNSSEC key...")
    const pattern = `/etc/coredns/keys/K${domain}.+013+*`;
    await removeFiles(pattern);
}

const removeCorefile = async (domain: string): Promise<void> => {
    console.log("Removing Corefile...")
    try {
        await Deno.remove(`/etc/coredns/corefiles/${domain}.Corefile`);
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            throw e;
        }
    }
}

const removeCaddyfile = async (domain: string): Promise<void> => {
    console.log("Removing Caddyfile...")
    try {
        await Deno.remove(`/etc/caddy/caddyfiles/${domain}.Caddyfile`);
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
            throw e;
        }
    }
}

const removeFiles = async (pattern: string): Promise<void> => {
    for await (const file of expandGlob(pattern)) {
        if (file.isFile) {
            await Deno.remove(file.path);
            console.log("Removed", file.path);
        }
    }
}


for await (const event of watcher) {
    if (event.kind === "create") {
        for (const path of event.paths) {
            if (domainRegex.test(path)) {
                // make sure file wasn't created by root before continuing
                const fileInfo = await Deno.stat(path);
                if (fileInfo.uid === 0) {
                    continue;
                }

                await createDomain(path);
            } else if (removeDomainRegex.test(path)) {
                // make sure file wasn't created by root before continuing
                const fileInfo = await Deno.stat(path);
                if (fileInfo.uid === 0) {
                    continue;
                }

                await removeDomain(path);
            }
        }
    }
}
