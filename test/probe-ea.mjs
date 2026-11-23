import { EaClient } from '../host/ea.js'

const ea = new EaClient({
  url: 'ws://127.0.0.1:18765/ws',
  origin: process.argv[2] || 'http://127.0.0.1:62462',
  symbol: 'XAUUSD',
  log: (...args) => console.log('[probe]', ...args),
})

ea.subscribe((state) => {
  console.log('phase=' + state.phase, '| error=' + JSON.stringify(state.error))
})

ea.start()
await new Promise((resolve) => setTimeout(resolve, 6000))
console.log('final:', ea.snapshot().phase, ea.snapshot().error)
ea.stop()
process.exit(0)
