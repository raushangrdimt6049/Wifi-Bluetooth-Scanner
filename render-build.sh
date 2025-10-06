#!/usr/bin/env bash
# exit on error
set -o errexit

# Install required system dependencies for bluetooth
apt-get update && apt-get install -y bluetooth bluez libbluetooth-dev libudev-dev

# Run the standard npm install
npm install