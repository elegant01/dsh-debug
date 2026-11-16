<?php

function greet(string $name, int $count): string {
    $message = sprintf("hello %s x%d", $name, $count); // BP: greet
    return $message;
}

$user = ['id' => 7, 'name' => 'ada'];
$msg = greet($user['name'], 42);
echo $msg, "\n"; // BP: print
usleep(50000);
echo "done\n";
