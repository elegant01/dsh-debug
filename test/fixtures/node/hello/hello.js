function greet(name, count) {
  const message = `hello ${name} x${count}` // BP: greet
  return message
}

const user = { id: 7, name: 'ada' }
const msg = greet(user.name, 42)
console.log(msg) // BP: print
setTimeout(() => { console.log('done') }, 50)
