// Flag any package in bun.lock published less than 24h ago.
const lock = Bun.JSONC.parse(await Bun.file(process.argv[2] ?? "bun.lock").text()) as { packages: Record<string, [string]> };
let bad = 0, n = 0;
for (const [spec] of Object.values(lock.packages)) {
  const at = spec.lastIndexOf("@"), name = spec.slice(0, at), version = spec.slice(at + 1);
  const time = await (await fetch(`https://registry.npmjs.org/${name}`)).json() as { time: Record<string, string> };
  const hours = (Date.now() - Date.parse(time.time[version])) / 36e5;
  n++;
  if (hours < 24) { bad++; console.log(`TOO NEW ${name}@${version} ${hours.toFixed(1)}h`); }
}
console.log(`${n} packages, ${bad} under 24h`);
