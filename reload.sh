#!/bin/sh

git pull
tsc
pm2 restart tokubot