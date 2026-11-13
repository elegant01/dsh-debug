package main

import (
	"fmt"
	"time"
)

type User struct {
	ID   int
	Name string
}

func greet(name string, count int) string {
	message := fmt.Sprintf("hello %s x%d", name, count) // BP: greet
	return message
}

func main() {
	user := User{ID: 7, Name: "ada"}
	msg := greet(user.Name, 42)
	fmt.Println(msg) // BP: print
	time.Sleep(50 * time.Millisecond)
	fmt.Println("done")
}
