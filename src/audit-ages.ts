// Flag any package in bun.lock published less than 24h ago.
const lock = Bun.JSONC.parse(await Bun.file(process.argv[2] ?? "bun.lock").text()) as { packages: Record<string, [string]> };
let bad = 0, n = 0;
for (const [spec] of Object.values(lock.packages)) {
  const at = spec.lastIndexOf("@"), name = spec.slice(0, at), version = spec.slice(at + 1);
  const time = await (await fetch(`https://registry.npmjs.org/${name}`)).json() as { time: Record<string, string> };
  const published = time.time[version];
  n++;
  // A version the registry has no publish time for can't be shown to be old enough.
  if (!published) { bad++; console.log(`NO PUBLISH TIME ${name}@${version}`); continue; }
  const hours = (Date.now() - Date.parse(published)) / 36e5;
  if (hours < 24) { bad++; console.log(`TOO NEW ${name}@${version} ${hours.toFixed(1)}h`); }
}
console.log(`${n} packages, ${bad} under 24h`);
