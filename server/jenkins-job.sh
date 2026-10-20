#!/bin/bash

port=8088;
pid=$(lsof -i:8088 -t);
if [ -z "$pid" ]
then
    echo "no server is running at $port"
else
    echo "shutting down server at $port"
    kill -9 $pid
fi    

echo "starting server at $port"

OLD_BUILD_ID=$BUILD_ID
BUILD_ID=DONTKILLME
./start-server.sh &
BUILD_ID=$OLD_BUILD_ID
