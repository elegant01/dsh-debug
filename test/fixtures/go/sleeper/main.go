package main

import (
	"fmt"
	"time"
)

func main() {
	for i := 0; i < 60; i++ {
		fmt.Printf("tick %d\n", i)
		time.Sleep(time.Second)
	}
}
