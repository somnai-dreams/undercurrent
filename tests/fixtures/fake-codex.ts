import { appendFile } from 'node:fs/promises'

const [recordPath, mode, ...args] = Bun.argv.slice(2)
if (recordPath === undefined) throw new Error('Fixture record path missing')
await appendFile(recordPath, `${JSON.stringify(args)}\n`)
switch (mode) {
  case 'success': console.log('Queued'); console.error('Warning before acceptance'); break
  case 'failure': console.error('Simulated native failure'); process.exitCode = 1; break
  case 'large-failure':
    await Bun.write(Bun.stderr, `EARLY DIAGNOSTIC\n${'padding '.repeat(8192)}LAST NATIVE ERROR\n`)
    process.exitCode = 1
    break
  case 'early-exit-wrapper': {
    const descendant = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60000)'], { stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
    await appendFile(`${recordPath}.descendant`, String(descendant.pid))
    console.error('Wrapper exited while descendant holds stderr')
    process.exit(1)
  }
  case 'timeout': console.error('Before native timeout'); await Bun.sleep(60_000); break
  case 'wrapper-timeout':
    console.error('Before native timeout')
    Bun.spawn([process.execPath, '-e', 'await Bun.sleep(60000)'], { stdout: 'inherit', stderr: 'inherit' })
    await Bun.sleep(60_000)
    break
  default: throw new Error('Fixture mode missing')
}
