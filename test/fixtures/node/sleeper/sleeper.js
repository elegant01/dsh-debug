let i = 0
const timer = setInterval(() => {
  console.log(`tick ${i++}`)
  if (i >= 60) clearInterval(timer)
}, 1000)
