import { appendFile } from 'node:fs/promises'

const [recordPath, mode, ...args] = Bun.argv.slice(2)
if (recordPath === undefined) throw new Error('Fixture record path missing')
await appendFile(recordPath, `${JSON.stringify(args)}\n`)
switch (mode) {
  case 'success': console.log('Queued'); break
  case 'failure': console.error('Simulated native failure'); process.exitCode = 1; break
  case 'timeout': await Bun.sleep(60_000); break
  case 'wrapper-timeout':
    Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60000)'], { stdout: 'inherit', stderr: 'inherit' })
    await Bun.sleep(60_000)
    break
  default: throw new Error('Fixture mode missing')
}
