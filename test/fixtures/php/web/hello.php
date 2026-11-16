<?php

function handle(string $name): array {
    $greeting = sprintf('hello %s', $name); // BP: handle
    return ['message' => $greeting, 'name' => $name];
}

$name = $_GET['name'] ?? 'world';
$result = handle($name);
header('Content-Type: application/json');
echo json_encode($result), "\n";
