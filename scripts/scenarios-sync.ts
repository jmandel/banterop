#!/usr/bin/env bun
/**
 * Scenarios backup/restore utility (Bun TS)
 *
 * Usage examples:
 *   # Backup all scenarios from a server to a local dir
 *   bun scripts/migration/scenarios-sync.ts backup --base https://banterop.fhir.me --out ./scenarios-backup
 *
 *   # Restore scenarios from a local dir to a server (upsert semantics)
 *   bun scripts/migration/scenarios-sync.ts restore --base https://banterop.fhir.me --dir ./scenarios-backup [--edit-token TOKEN]
 */

type ScenarioConfig = {
  metadata?: { id?: string; title?: string; tags?: string[]; [k: string]: any }
  [k: string]: any
}

type Args = {
  cmd: 'backup'|'restore'
  base: string
  out?: string
  dir?: string
  editToken?: string
  mode?: 'upsert'|'create'|'update'
}

function parseArgs(argv: string[]): Args {
  const [_bun, _script, cmd = '', ...rest] = argv
  if (!['backup','restore'].includes(cmd)) usageAndExit(`Unknown or missing command: ${cmd}`)

  const out: Record<string,string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--base') { out.base = String(rest[++i]||'') }
    else if (a === '--out') { out.out = String(rest[++i]||'') }
    else if (a === '--dir') { out.dir = String(rest[++i]||'') }
    else if (a === '--edit-token') { out.editToken = String(rest[++i]||'') }
    else if (a === '--mode') { out.mode = String(rest[++i]||'') as any }
    else usageAndExit(`Unknown arg: ${a}`)
  }

  const base = out.base || Bun.env.BASE_URL || 'https://banterop.fhir.me'
  const editToken = out.editToken || Bun.env.EDIT_TOKEN || ''
  const mode = (out.mode as any) || 'upsert'
  return { cmd: cmd as any, base, out: out.out, dir: out.dir, editToken, mode }
}

function usageAndExit(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`)
  console.error(`Usage:
  backup: bun scripts/migration/scenarios-sync.ts backup --base <URL> --out <DIR>
  restore: bun scripts/migration/scenarios-sync.ts restore --base <URL> --dir <DIR> [--edit-token TOKEN] [--mode upsert|create|update]
`)
  process.exit(1)
}

async function ensureDir(dir: string) {
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
}

function safeId(id: string): string { return id.replace(/[^A-Za-z0-9._-]+/g, '_') }

async function backupAll(base: string, outDir: string) {
  if (!outDir) usageAndExit('Missing --out <DIR>')
  console.log(`Backing up scenarios from ${base} → ${outDir}`)
  await ensureDir(outDir)

  const r = await fetch(`${base.replace(/\/+$/,'')}/api/scenarios`)
  if (!r.ok) throw new Error(`GET /api/scenarios failed: ${r.status} ${r.statusText}`)
  const arr = await r.json().catch(()=>[]) as ScenarioConfig[]
  if (!Array.isArray(arr)) throw new Error('Invalid response payload: expected array')

  let ok = 0, fail = 0
  for (const sc of arr) {
    const id = String(sc?.metadata?.id || '').trim()
    if (!id) { fail++; console.warn('Skipping scenario with no metadata.id'); continue }
    const name = `${safeId(id)}.json`
    const path = `${outDir.replace(/\/+$/,'')}/${name}`
    try {
      await Bun.write(path, JSON.stringify(sc, null, 2) + '\n')
      ok++
    } catch (e) {
      fail++
      console.error(`Failed to write ${name}:`, e)
    }
  }
  console.log(`Done. Wrote ${ok} files${fail?`, ${fail} skipped/failed`:''}.`)
}

async function restoreDir(base: string, dir: string, mode: 'upsert'|'create'|'update', editToken?: string) {
  if (!dir) usageAndExit('Missing --dir <DIR>')
  console.log(`Restoring scenarios from ${dir} → ${base} (mode=${mode})`)

  const glob = new Bun.Glob('*.json')
  const files: string[] = []
  for await (const f of glob.scan({ cwd: dir })) files.push(f)
  if (!files.length) { console.warn('No *.json files found'); return }

  let created = 0, updated = 0, skipped = 0, failed = 0
  for (const f of files) {
    const p = `${dir.replace(/\/+$/,'')}/${f}`
    let obj: ScenarioConfig | null = null
    try { obj = JSON.parse(await Bun.file(p).text()) } catch (e) { failed++; console.error(`Parse error for ${f}:`, e); continue }
    const id = String(obj?.metadata?.id || '').trim()
    if (!id) { failed++; console.error(`Missing metadata.id in ${f}`); continue }

    const headers: Record<string,string> = { 'content-type':'application/json' }
    if (editToken) headers['X-Edit-Token'] = editToken

    async function doCreate() {
      const res = await fetch(`${base.replace(/\/+$/,'')}/api/scenarios`, { method:'POST', headers, body: JSON.stringify({ config: obj }) })
      if (res.ok) { created++; return true }
      if (res.status === 409) return false // exists
      failed++; console.error(`POST ${id} failed: ${res.status} ${await res.text().catch(()=>res.statusText)}`); return null
    }
    async function doUpdate() {
      const res = await fetch(`${base.replace(/\/+$/,'')}/api/scenarios/${encodeURIComponent(id)}`, { method:'PUT', headers, body: JSON.stringify({ config: obj }) })
      if (res.ok) { updated++; return true }
      if (res.status === 404) return false // missing
      failed++; console.error(`PUT ${id} failed: ${res.status} ${await res.text().catch(()=>res.statusText)}`); return null
    }

    if (mode === 'create') { await doCreate(); continue }
    if (mode === 'update') { const ok = await doUpdate(); if (ok === false) skipped++; continue }

    // upsert: try create, then update on conflict
    const c = await doCreate()
    if (c === false) { // exists
      const u = await doUpdate()
      if (u === false) { skipped++ }
    }
  }

  console.log(`Done. Created:${created} Updated:${updated} Skipped:${skipped} Failed:${failed}`)
}

async function main() {
  const args = parseArgs(Bun.argv)
  if (args.cmd === 'backup') return backupAll(args.base, args.out!)
  if (args.cmd === 'restore') return restoreDir(args.base, args.dir!, args.mode!, args.editToken)
}

main().catch((e) => { console.error(e); process.exit(1) })

