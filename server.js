const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const wifi = require('node-wifi');
const noble = require('@abandonware/noble');

const app = express();
const port = 3000;

// Path for storing previously connected Bluetooth devices
const PREVIOUS_DEVICES_FILE = path.join(__dirname, 'previous_devices.json');

// Initialize Wi-Fi
wifi.init({
    iface: null // Use a random available wifi interface
});

app.use(express.json());

// Serve static files from the project root directory
app.use(express.static(__dirname));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Wi-Fi Endpoints ---

// Scan for Wi-Fi networks
app.get('/api/wifi', async (req, res) => {
    try {
        const networks = await wifi.scan();
        // Map the network object to what the frontend expects
        const mappedNetworks = networks.map(net => ({
            ssid: net.ssid,
            bssid: net.bssid,
            strength: net.quality, // quality is already in %
            networkType: net.mode,
            authentication: net.security,
            encryption: net.security_flags
        }));
        res.json(mappedNetworks);
    } catch (error) {
        console.error('Wi-Fi scan error:', error);
        res.status(500).json({ error: 'Failed to scan for Wi-Fi networks', details: error.message });
    }
});

// Get current Wi-Fi connection
app.get('/api/current-connection', async (req, res) => {
    try {
        const connections = await wifi.getCurrentConnections();
        res.json(connections);
    } catch (error) {
        console.error('Get current connection error:', error);
        res.status(500).json({ error: 'Failed to get current Wi-Fi connection', details: error.message });
    }
});

// Connect to a Wi-Fi network
app.post('/api/connect', async (req, res) => {
    const { ssid, password } = req.body;
    if (!ssid) {
        return res.status(400).json({ error: 'SSID is required' });
    }

    try {
        // If a password is provided, just try to connect with it.
        if (password) {
            await wifi.connect({ ssid, password });
            return res.json({ message: `Successfully initiated connection to ${ssid}` });
        }

        // If no password, first try connecting directly.
        // This will work for open networks or for networks already saved on the system.
        try {
            await wifi.connect({ ssid });
            return res.json({ message: `Successfully initiated connection to ${ssid}` });
        } catch (error) {
            // If the initial connection fails, check if the network is secure.
            // If it is, we need a password.
            const networks = await wifi.scan();
            const network = networks.find(n => n.ssid === ssid);
            if (network && network.security && network.security !== 'Open') {
                // 401 tells the frontend to prompt for a password.
                return res.status(401).json({ error: 'Password is required for this secure network.' });
            }
            // If it's not a secure network or another error occurred, throw it.
            throw error;
        }
    } catch (error) {
        console.error(`Failed to connect to ${ssid}:`, error);
        res.status(500).json({ error: `Failed to connect to ${ssid}`, details: error.message });
    }
});

// Disconnect from the current Wi-Fi network
app.post('/api/disconnect', async (req, res) => {
    try {
        // The 'disconnect' function might not be available on all platforms in node-wifi.
        // We can provide a fallback or platform-specific implementation if needed.
        await wifi.disconnect();
        res.json({ message: 'Successfully disconnected from the Wi-Fi network.' });
    } catch (error) {
        console.error('Disconnect error:', error);
        // node-wifi's disconnect can throw errors if not supported or if not connected.
        res.status(500).json({ error: 'Failed to disconnect.', details: error.message });
    }
});

// Forget a Wi-Fi network
app.post('/api/forget', async (req, res) => {
    const { ssid } = req.body;
    if (!ssid) {
        return res.status(400).json({ error: 'SSID is required to forget a network.' });
    }

    // The node-wifi `deleteConnection` does not support Windows.
    // We will use the native `netsh` command instead.
    const { exec } = require('child_process');
    const command = `netsh wlan delete profile name="${ssid}"`;

    exec(command, (error, stdout, stderr) => {
        if (error || stderr) {
            const errorMessage = stderr || error.message;
            console.error(`Failed to forget network ${ssid}:`, errorMessage);
            // Check for a common error when the profile doesn't exist
            if (errorMessage.includes("is not found on the system")) {
                return res.status(404).json({ error: `Profile for "${ssid}" not found.` });
            }
            return res.status(500).json({ error: `Failed to forget network profile for "${ssid}".`, details: errorMessage });
        }
        console.log(`Successfully forgot network: ${ssid}`);
        res.json({ message: `Successfully forgot network profile for "${ssid}".` });
    });
});

// --- Bluetooth Endpoint ---

// A simple in-memory cache to hold discovered devices during a scan
const discoveredDevices = new Map();
const connectedPeripheral = { device: null }; // To hold the currently connected peripheral
let isScanningBluetooth = false;

// --- Helper functions for managing previous devices ---
async function getPreviousDevices() {
    try {
        await fs.access(PREVIOUS_DEVICES_FILE);
        const data = await fs.readFile(PREVIOUS_DEVICES_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // If the file doesn't exist or is empty, return an empty array
        return [];
    }
}

async function saveDevice(device) {
    const devices = await getPreviousDevices();
    // Avoid duplicates by checking the address
    if (!devices.some(d => d.address === device.address)) {
        devices.push(device);
        await fs.writeFile(PREVIOUS_DEVICES_FILE, JSON.stringify(devices, null, 2));
    }
}

// --- Bluetooth Endpoints ---

// Get previously connected Bluetooth devices
app.get('/api/bluetooth-previous-devices', async (req, res) => {
    try {
        const devices = await getPreviousDevices();
        res.json(devices);
    } catch (error) {
        console.error('Error getting previous devices:', error);
        res.status(500).json({ error: 'Failed to retrieve previous devices.' });
    }
});

// Connect to a Bluetooth device
app.post('/api/bluetooth-connect', async (req, res) => {
    const { address } = req.body;
    if (!address) {
        return res.status(400).json({ error: 'Device address is required.' });
    }

    // Stop any ongoing scan to allow connection
    if (noble.state === 'scanning' || isScanningBluetooth) {
        try {
            await noble.stopScanningAsync();
        } catch (e) {
            // Ignore errors if already stopping
        }
    }

    // Find the peripheral from the last scan cache
    let peripheral = discoveredDevices.get(address.toLowerCase())?.peripheral;

    if (!peripheral) {
        // If not in cache, it might be a previously saved device.
        // Try to find it with a quick, targeted scan.
        console.log(`Device ${address} not in cache. Starting a new scan to find it...`);
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    noble.stopScanning();
                    reject(new Error('Device not found within the time limit.'));
                }, 7000); // 7-second timeout to find the device

                noble.on('discover', (p) => {
                    if (p.address.toLowerCase() === address.toLowerCase()) {
                        console.log(`Found device ${address} via targeted scan.`);
                        peripheral = p;
                        noble.stopScanning();
                        clearTimeout(timeout);
                        noble.removeAllListeners('discover');
                        resolve();
                    }
                });

                noble.startScanning([], false); // Scan for any device
            });
        } catch (scanError) {
            return res.status(404).json({ error: 'Device not found. Please ensure it is nearby and discoverable, then refresh the list.' });
        }
    }

    try {
        await peripheral.connectAsync();
        const deviceName = peripheral.advertisement.localName || 'Unknown Device';
        console.log(`Connected to ${deviceName} [${address}]`); // We no longer auto-save on connect
        // await saveDevice({ name: deviceName, address: address.toUpperCase() });
        res.json({ message: `Successfully connected to ${deviceName}` });
    } catch (error) {
        console.error(`Failed to connect to ${address}:`, error);
        res.status(500).json({ error: `Failed to connect to device`, details: error.message });
    }
});

// Endpoint to explicitly save a device
app.post('/api/bluetooth-save', async (req, res) => {
    const { name, address } = req.body;
    if (!address) {
        return res.status(400).json({ error: 'Device address is required.' });
    }
    try {
        await saveDevice({ name: name || 'Unknown Device', address: address.toUpperCase() });
        res.json({ message: `Successfully saved device ${name || address}` });
    } catch (error) {
        console.error(`Failed to save device ${address}:`, error);
        res.status(500).json({ error: 'Failed to save device.' });
    }
});

app.get('/api/bluetooth-devices', async (req, res) => {
    if (isScanningBluetooth) {
        return res.status(429).json({ error: 'A Bluetooth scan is already in progress.' });
    }
    isScanningBluetooth = true;
    discoveredDevices.clear();

    try {
        // Start scanning
        await noble.startScanningAsync([], false);
        console.log('Bluetooth scanning started...');

        const onDiscover = (peripheral) => {
            // Use address or id as a unique key
            const address = peripheral.address || peripheral.id;
            // Use the local name from the advertisement data
            const name = peripheral.advertisement.localName;

            if (!discoveredDevices.has(address.toLowerCase())) {
                console.log(`Discovered: ${name || 'Unknown'} [${address}]`);
                discoveredDevices.set(address.toLowerCase(), {
                    name: name ? name : 'Unknown Device',
                    address: address.toUpperCase(), // Ensure address is always uppercase for consistency
                    peripheral: peripheral // Store the peripheral object for connecting later
                });
            }
        };

        noble.on('discover', onDiscover);

        // Scan for 5 seconds, then stop and return the results
        setTimeout(async () => {
            await noble.stopScanningAsync();
            noble.removeListener('discover', onDiscover);
            console.log('Bluetooth scanning stopped.');
            isScanningBluetooth = false;
            res.json(Array.from(discoveredDevices.values()));
        }, 5000); // Scan duration
    } catch (error) {
        console.error('Bluetooth scan error:', error);
        res.status(500).json({ error: 'Failed to scan for Bluetooth devices', details: error.message });
        isScanningBluetooth = false;
    }
});

app.listen(port, async () => {
    // Ensure the previous devices file exists on startup
    try {
        await fs.access(PREVIOUS_DEVICES_FILE);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('previous_devices.json not found. Creating it...');
            await fs.writeFile(PREVIOUS_DEVICES_FILE, '[]', 'utf-8');
        } else {
            console.error('Error checking for previous_devices.json:', error);
        }
    }
    console.log(`Net Nexus portal running at http://localhost:${port}`);
});