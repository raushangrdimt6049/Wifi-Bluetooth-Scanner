const express = require('express');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const port = 3000;

// Serve static files from the current directory (for index.html, css, etc.)
app.use(express.static(__dirname));

// Serve index.html at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to get Wi-Fi networks
app.get('/api/wifi', (req, res) => {
    // This command is for Windows and provides all the necessary details.
    exec('netsh wlan show networks', (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return res.status(500).json({ error: 'Failed to scan networks.', details: error.message });
        }
        if (stderr) {
            // stderr can contain warnings, so we log it but don't treat it as a fatal error.
            console.warn(`exec stderr: ${stderr}`);
        }
        const networks = parseWifiNetworks(stdout);
        res.json(networks);
    });
});

/**
 * Parses the output of 'netsh wlan show networks' to extract details for each Wi-Fi network.
 * @param {string} output The raw string output from the command.
 * @returns {Array<Object>} An array of network objects.
 */
function parseWifiNetworks(output) {
    const networks = [];
    // Split by the "SSID" keyword to get blocks for each network
    const networkBlocks = output.split(/SSID \d+ :/g);

    // Start from 1 to skip the header info before the first SSID
    for (let i = 1; i < networkBlocks.length; i++) {
        const block = networkBlocks[i];
        const lines = block.split('\n');

        const ssid = lines[0] ? lines[0].trim() : null;
        if (!ssid) continue;

        const network = {
            ssid: ssid,
        };

        for (const line of lines) {
            if (line.includes('Network type')) network.networkType = line.split(':')[1].trim();
            if (line.includes('Authentication')) network.authentication = line.split(':')[1].trim();
            if (line.includes('Encryption')) network.encryption = line.split(':')[1].trim();
            if (line.includes('Signal')) network.strength = line.split(':')[1].trim().replace('%', '');
        }
        networks.push(network);
    }
    return networks;
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});