require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const XLSX = require('xlsx');
const axios = require('axios');
const chalk = require('chalk'); // Add chalk for colored console output

const app = express();
const PORT = process.env.PORT || 3000;
const ROUTE_DATA_PATH = process.env.ROUTE_DATA_PATH || './route_data';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const OVERPASS_API_URL = process.env.OVERPASS_API_URL || 'http://43.250.40.133:8080/api/interpreter';
const ENABLE_CACHE = process.env.ENABLE_CACHE === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600');
const OVERPASS_TIMEOUT = parseInt(process.env.OVERPASS_TIMEOUT || '30000');
const WEATHER_TIMEOUT = parseInt(process.env.WEATHER_TIMEOUT || '5000');

// CORS configuration
const corsOptions = {
    origin: process.env.CORS_ORIGIN || '*',
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public'));

// Cache for route data
let routeCache = {};
let cacheTimestamps = {};

// Store for progress tracking
let processProgress = {
    status: 'idle',
    totalRoutes: 0,
    processedRoutes: 0,
    currentRoute: '',
    errors: []
};

// Enhanced logging with colors
function log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logLevel = process.env.LOG_LEVEL || 'info';
    const levels = ['error', 'warn', 'info', 'debug'];
    
    if (levels.indexOf(level) <= levels.indexOf(logLevel)) {
        let coloredMessage = `[${timestamp}]`;
        
        switch(level) {
            case 'error':
                coloredMessage = chalk.red(`[${timestamp}] [ERROR] ${message}`);
                break;
            case 'warn':
                coloredMessage = chalk.yellow(`[${timestamp}] [WARN] ${message}`);
                break;
            case 'info':
                coloredMessage = chalk.blue(`[${timestamp}] [INFO] ${message}`);
                break;
            case 'debug':
                coloredMessage = chalk.gray(`[${timestamp}] [DEBUG] ${message}`);
                break;
        }
        
        console.log(coloredMessage);
        if (Object.keys(data).length > 0) {
            console.log(chalk.gray(JSON.stringify(data, null, 2)));
        }
    }
}

// Cache helper functions
function getCacheKey(routeId) {
    return `route_${routeId}`;
}

function isCacheValid(key) {
    if (!ENABLE_CACHE) return false;
    const timestamp = cacheTimestamps[key];
    if (!timestamp) return false;
    return (Date.now() - timestamp) < (CACHE_TTL * 1000);
}

function setCache(key, data) {
    if (ENABLE_CACHE) {
        routeCache[key] = data;
        cacheTimestamps[key] = Date.now();
    }
}

// Function to parse route files
async function parseRouteFile(filePath) {
    try {
        const ext = path.extname(filePath).toLowerCase();
        
        if (ext === '.xlsx') {
            const fileBuffer = await fs.readFile(filePath);
            const workbook = XLSX.read(fileBuffer);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const data = XLSX.utils.sheet_to_json(sheet);
            
            log('debug', `Parsing Excel file: ${path.basename(filePath)}`, { rows: data.length });
            
            // Extract latitude and longitude
            const coordinates = data.map(row => ({
                lat: parseFloat(row.Latitude || row.latitude || row.LAT || row.lat || 0),
                lng: parseFloat(row.Longitude || row.longitude || row.LON || row.lng || row.lon || 0),
                stepId: row.Step_ID || row.step_id || null,
                ...row
            })).filter(coord => coord.lat && coord.lng);
            
            // Sort by step ID if available
            if (coordinates.length > 0 && coordinates[0].stepId) {
                coordinates.sort((a, b) => parseInt(a.stepId) - parseInt(b.stepId));
            }
            
            log('info', `✓ Parsed ${coordinates.length} coordinates from ${path.basename(filePath)}`);
            return coordinates;
        }
        
        return [];
    } catch (error) {
        log('error', `✗ Error parsing file ${filePath}:`, { error: error.message });
        return [];
    }
}

// Function to parse CSV route info
async function parseRouteCSV(csvPath) {
    try {
        const fileContent = await fs.readFile(csvPath, 'utf8');
        const lines = fileContent.split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        
        log('info', chalk.green(`\n📋 Reading CSV: ${path.basename(csvPath)}`));
        log('debug', `Headers: ${headers.join(', ')}`);
        
        const routes = [];
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim());
            if (values.length >= headers.length && values.some(v => v)) { // Skip empty lines
                const route = {};
                headers.forEach((header, index) => {
                    route[header] = values[index];
                });
                routes.push(route);
            }
        }
        
        log('info', chalk.green(`✓ Found ${routes.length} routes in CSV`));
        return routes;
    } catch (error) {
        log('error', '✗ Error parsing CSV:', { error: error.message });
        return [];
    }
}

// Function to get route info from filename
function getRouteInfo(filename) {
    const baseName = path.basename(filename, '.xlsx');
    const parts = baseName.split('_');
    return {
        depotCode: parts[0] || 'Unknown',
        consumerCode: parts[1] || 'Unknown',
        filename: filename
    };
}

// Function to make Overpass API query
async function queryOverpass(query) {
    try {
        const response = await axios.post(
            OVERPASS_API_URL,
            `data=${encodeURIComponent(query)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: OVERPASS_TIMEOUT
            }
        );
        return response.data;
    } catch (error) {
        log('error', 'Overpass API error', { 
            error: error.message,
            url: OVERPASS_API_URL,
            query: query.substring(0, 100) + '...'
        });
        throw error;
    }
}

// Function to check if location is petrol pump
async function checkPetrolPump(lat, lng) {
    try {
        const query = `[out:json][timeout:25];
(
  node["amenity"="fuel"](around:500,${lat},${lng});
  way["amenity"="fuel"](around:500,${lat},${lng});
);
out center;`;
        
        const data = await queryOverpass(query);
        return data.elements && data.elements.length > 0;
    } catch (error) {
        log('error', 'Error checking petrol pump', { error: error.message, lat, lng });
        return false;
    }
}

// Function to get amenities along route
async function getRouteAmenities(coordinates) {
    try {
        // Create bounding box from coordinates
        const lats = coordinates.map(c => c.lat);
        const lngs = coordinates.map(c => c.lng);
        const minLat = Math.min(...lats) - 0.01;
        const maxLat = Math.max(...lats) + 0.01;
        const minLng = Math.min(...lngs) - 0.01;
        const maxLng = Math.max(...lngs) + 0.01;
        
        const query = `[out:json][timeout:30];
(
  node["amenity"](${minLat},${minLng},${maxLat},${maxLng});
  way["amenity"](${minLat},${minLng},${maxLat},${maxLng});
  node["shop"](${minLat},${minLng},${maxLat},${maxLng});
  way["shop"](${minLat},${minLng},${maxLat},${maxLng});
  node["tourism"](${minLat},${minLng},${maxLat},${maxLng});
  way["tourism"](${minLat},${minLng},${maxLat},${maxLng});
);
out center;`;
        
        const data = await queryOverpass(query);
        
        if (!data.elements) return [];
        
        return data.elements.map(element => ({
            type: element.tags.amenity || element.tags.shop || element.tags.tourism || 'unknown',
            name: element.tags.name || 'Unnamed',
            lat: element.lat || element.center?.lat,
            lng: element.lon || element.center?.lon,
            address: element.tags['addr:full'] || element.tags['addr:street'] || '',
            phone: element.tags.phone || '',
            website: element.tags.website || ''
        })).filter(amenity => amenity.lat && amenity.lng);
    } catch (error) {
        log('error', 'Error fetching amenities', { error: error.message });
        return [];
    }
}

// Function to detect sharp turns
function detectSharpTurns(coordinates) {
    const sharpTurns = [];
    const sharpTurnThreshold = 60; // degrees
    
    for (let i = 1; i < coordinates.length - 1; i++) {
        const p1 = coordinates[i - 1];
        const p2 = coordinates[i];
        const p3 = coordinates[i + 1];
        
        // Calculate bearing changes
        const bearing1 = calculateBearing(p1.lat, p1.lng, p2.lat, p2.lng);
        const bearing2 = calculateBearing(p2.lat, p2.lng, p3.lat, p3.lng);
        
        let turnAngle = Math.abs(bearing2 - bearing1);
        if (turnAngle > 180) turnAngle = 360 - turnAngle;
        
        if (turnAngle > sharpTurnThreshold) {
            sharpTurns.push({
                lat: p2.lat,
                lng: p2.lng,
                angle: turnAngle,
                index: i
            });
        }
    }
    
    return sharpTurns;
}

// Calculate bearing between two points
function calculateBearing(lat1, lng1, lat2, lng2) {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    
    const y = Math.sin(dLng) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
    
    const bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

// Function to get weather data
async function getWeatherData(lat, lng) {
    try {
        if (!OPENWEATHER_API_KEY || OPENWEATHER_API_KEY === '') {
            log('debug', 'Weather API not configured');
            return null;
        }
        
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_API_KEY}&units=metric`;
        
        const response = await axios.get(url, { timeout: WEATHER_TIMEOUT });
        return {
            temperature: response.data.main.temp,
            description: response.data.weather[0].description,
            humidity: response.data.main.humidity,
            windSpeed: response.data.wind.speed
        };
    } catch (error) {
        log('error', 'Error fetching weather', { error: error.message, lat, lng });
        return null;
    }
}

// API endpoint to test Overpass connection
app.get('/api/test-overpass', async (req, res) => {
    try {
        const testQuery = '[out:json];node[name="Mumbai"];out;';
        const data = await queryOverpass(testQuery);
        res.json({
            success: true,
            message: 'Overpass API is accessible',
            overpassUrl: OVERPASS_API_URL,
            testResult: data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to connect to Overpass API',
            error: error.message,
            overpassUrl: OVERPASS_API_URL
        });
    }
});

// API endpoint to get progress
app.get('/api/progress', (req, res) => {
    res.json(processProgress);
});

// API endpoint to get all routes (ONLY from CSV)
app.get('/api/routes', async (req, res) => {
    try {
        processProgress = {
            status: 'processing',
            totalRoutes: 0,
            processedRoutes: 0,
            currentRoute: '',
            errors: []
        };
        
        const routeDataPath = path.resolve(ROUTE_DATA_PATH);
        
        // Check if directory exists
        try {
            await fs.access(routeDataPath);
        } catch {
            log('warn', 'Route data directory does not exist', { path: routeDataPath });
            processProgress.status = 'error';
            processProgress.errors.push('Route data directory does not exist');
            return res.json([]);
        }
        
        const files = await fs.readdir(routeDataPath);
        const xlsxFiles = files.filter(file => file.endsWith('.xlsx'));
        const csvFiles = files.filter(file => file.endsWith('.csv'));
        
        log('info', chalk.cyan('\n=== Starting Route Processing ==='));
        log('info', `📁 Directory: ${routeDataPath}`);
        log('info', `📊 Found: ${xlsxFiles.length} Excel files, ${csvFiles.length} CSV files`);
        
        if (csvFiles.length === 0) {
            log('error', chalk.red('✗ No CSV files found! Routes must be defined in CSV.'));
            processProgress.status = 'error';
            processProgress.errors.push('No CSV files found');
            return res.json([]);
        }
        
        const routes = [];
        let totalCsvRoutes = 0;
        let matchedRoutes = 0;
        let missingRoutes = 0;
        
        // Process ONLY routes defined in CSV files
        for (const csvFile of csvFiles) {
            const csvPath = path.join(routeDataPath, csvFile);
            const csvData = await parseRouteCSV(csvPath);
            
            totalCsvRoutes += csvData.length;
            processProgress.totalRoutes = totalCsvRoutes;
            
            log('info', chalk.yellow(`\n🔍 Processing routes from ${csvFile}...`));
            
            for (let i = 0; i < csvData.length; i++) {
                const row = csvData[i];
                const buCode = row['BU Code'] || '';
                const rowLabel = row['Row Labels'] || '';
                const customerName = row['Customer Name'] || '';
                const location = row['Location'] || '';
                
                processProgress.currentRoute = `${buCode}_${rowLabel}`;
                processProgress.processedRoutes = i + 1;
                
                log('debug', `\n  Route ${i + 1}/${csvData.length}: ${buCode}_${rowLabel}`);
                log('debug', `  Customer: ${customerName}`);
                
                // Generate possible filenames for this route
                const possibleFilenames = [
                    `${buCode}_${rowLabel}.xlsx`,
                    `${buCode}_00${rowLabel}.xlsx`,
                    `${buCode}_0${rowLabel}.xlsx`,
                    `${buCode}_${rowLabel.padStart(10, '0')}.xlsx`,
                    `${rowLabel}.xlsx`
                ];
                
                // Look for matching Excel file
                let foundFile = null;
                let coordinates = [];
                
                for (const possibleName of possibleFilenames) {
                    if (xlsxFiles.includes(possibleName)) {
                        foundFile = possibleName;
                        const filePath = path.join(routeDataPath, possibleName);
                        coordinates = await parseRouteFile(filePath);
                        log('info', chalk.green(`  ✓ Found Excel file: ${possibleName}`));
                        matchedRoutes++;
                        break;
                    }
                }
                
                if (!foundFile) {
                    log('warn', chalk.yellow(`  ⚠ No Excel file found for ${buCode}_${rowLabel}`));
                    log('debug', `  Expected one of: ${possibleFilenames.join(', ')}`);
                    missingRoutes++;
                }
                
                // Create route entry
                if (foundFile && coordinates.length > 0) {
                    const startCoord = coordinates[0];
                    const endCoord = coordinates[coordinates.length - 1];
                    
                    routes.push({
                        id: foundFile,
                        depotCode: buCode,
                        consumerCode: rowLabel,
                        customerName: customerName,
                        location: location,
                        filename: foundFile,
                        totalSteps: coordinates.length,
                        hasCoordinates: true,
                        startLocation: {
                            lat: startCoord.lat,
                            lng: startCoord.lng
                        },
                        endLocation: {
                            lat: endCoord.lat,
                            lng: endCoord.lng
                        }
                    });
                } else {
                    // Add route info even without Excel file
                    routes.push({
                        id: `pending_${buCode}_${rowLabel}`,
                        depotCode: buCode,
                        consumerCode: rowLabel,
                        customerName: customerName,
                        location: location,
                        filename: 'No file found',
                        totalSteps: 0,
                        hasCoordinates: false,
                        expectedFilenames: possibleFilenames,
                        startLocation: null,
                        endLocation: null
                    });
                    
                    processProgress.errors.push(`Missing file for route: ${buCode}_${rowLabel}`);
                }
            }
        }
        
        // Summary
        log('info', chalk.cyan('\n=== Processing Complete ==='));
        log('info', chalk.green(`✓ Total routes in CSV: ${totalCsvRoutes}`));
        log('info', chalk.green(`✓ Routes with Excel files: ${matchedRoutes}`));
        log('warn', chalk.yellow(`⚠ Routes missing Excel files: ${missingRoutes}`));
        log('info', chalk.blue(`📊 Success rate: ${((matchedRoutes/totalCsvRoutes)*100).toFixed(1)}%\n`));
        
        processProgress.status = 'complete';
        res.json(routes);
    } catch (error) {
        log('error', 'Error getting routes', { error: error.message });
        processProgress.status = 'error';
        processProgress.errors.push(error.message);
        res.status(500).json({ error: 'Failed to fetch routes' });
    }
});

// API endpoint to get route details
app.get('/api/routes/:routeId', async (req, res) => {
    try {
        const { routeId } = req.params;
        const cacheKey = getCacheKey(routeId);
        
        // Check cache first
        if (isCacheValid(cacheKey)) {
            log('info', `Serving route ${routeId} from cache`);
            return res.json(routeCache[cacheKey]);
        }
        
        const filePath = path.join(path.resolve(ROUTE_DATA_PATH), routeId);
        
        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: 'Route file not found' });
        }
        
        log('info', chalk.blue(`\n📍 Processing route details for: ${routeId}`));
        
        const coordinates = await parseRouteFile(filePath);
        
        if (coordinates.length === 0) {
            return res.status(404).json({ error: 'No valid coordinates found in route file' });
        }
        
        const startCoord = coordinates[0];
        const endCoord = coordinates[coordinates.length - 1];
        
        log('info', `  Waypoints: ${coordinates.length}`);
        log('info', `  Distance: Calculating...`);
        
        // Check if start and end are petrol pumps
        log('info', '  Checking petrol pumps...');
        const [isStartPetrolPump, isEndPetrolPump] = await Promise.all([
            checkPetrolPump(startCoord.lat, startCoord.lng),
            checkPetrolPump(endCoord.lat, endCoord.lng)
        ]);
        log('info', `  Start is petrol pump: ${isStartPetrolPump ? '✓ Yes' : '✗ No'}`);
        log('info', `  End is petrol pump: ${isEndPetrolPump ? '✓ Yes' : '✗ No'}`);
        
        // Get amenities, sharp turns, and weather
        log('info', '  Fetching amenities and analyzing route...');
        const [amenities, sharpTurns, startWeather, endWeather] = await Promise.all([
            getRouteAmenities(coordinates),
            detectSharpTurns(coordinates),
            getWeatherData(startCoord.lat, startCoord.lng),
            getWeatherData(endCoord.lat, endCoord.lng)
        ]);
        
        log('info', `  Amenities found: ${amenities.length}`);
        log('info', `  Sharp turns detected: ${sharpTurns.length}`);
        log('info', chalk.green(`✓ Route processing complete\n`));
        
        const routeDetails = {
            routeInfo: getRouteInfo(routeId),
            coordinates: coordinates,
            startLocation: {
                ...startCoord,
                isPetrolPump: isStartPetrolPump,
                weather: startWeather
            },
            endLocation: {
                ...endCoord,
                isPetrolPump: isEndPetrolPump,
                weather: endWeather
            },
            amenities: amenities,
            sharpTurns: sharpTurns,
            totalDistance: calculateTotalDistance(coordinates),
            bounds: {
                north: Math.max(...coordinates.map(c => c.lat)),
                south: Math.min(...coordinates.map(c => c.lat)),
                east: Math.max(...coordinates.map(c => c.lng)),
                west: Math.min(...coordinates.map(c => c.lng))
            }
        };
        
        // Cache the result
        setCache(cacheKey, routeDetails);
        
        res.json(routeDetails);
    } catch (error) {
        log('error', 'Error getting route details', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch route details' });
    }
});

// Calculate total distance of route
function calculateTotalDistance(coordinates) {
    let totalDistance = 0;
    
    for (let i = 1; i < coordinates.length; i++) {
        const distance = calculateDistance(
            coordinates[i - 1].lat,
            coordinates[i - 1].lng,
            coordinates[i].lat,
            coordinates[i].lng
        );
        totalDistance += distance;
    }
    
    return totalDistance.toFixed(2);
}

// Calculate distance between two points (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// API endpoint to show route mapping status
app.get('/api/route-status', async (req, res) => {
    try {
        const routeDataPath = path.resolve(ROUTE_DATA_PATH);
        
        try {
            await fs.access(routeDataPath);
        } catch {
            return res.json({
                error: 'Route data directory does not exist',
                path: routeDataPath
            });
        }
        
        const files = await fs.readdir(routeDataPath);
        const xlsxFiles = files.filter(file => file.endsWith('.xlsx'));
        const csvFiles = files.filter(file => file.endsWith('.csv'));
        
        const status = {
            csvFiles: csvFiles,
            xlsxFiles: xlsxFiles,
            expectedRoutes: [],
            matchedRoutes: [],
            unmatchedRoutes: [],
            orphanFiles: []
        };
        
        // Process CSV to get expected routes
        for (const csvFile of csvFiles) {
            const csvPath = path.join(routeDataPath, csvFile);
            const csvData = await parseRouteCSV(csvPath);
            
            for (const row of csvData) {
                const buCode = row['BU Code'] || '';
                const rowLabel = row['Row Labels'] || '';
                const customerName = row['Customer Name'] || '';
                
                const expectedFilenames = [
                    `${buCode}_${rowLabel}.xlsx`,
                    `${buCode}_00${rowLabel}.xlsx`,
                    `${buCode}_0${rowLabel}.xlsx`
                ];
                
                let matched = false;
                let matchedFile = null;
                
                for (const filename of expectedFilenames) {
                    if (xlsxFiles.includes(filename)) {
                        matched = true;
                        matchedFile = filename;
                        break;
                    }
                }
                
                const routeInfo = {
                    buCode,
                    rowLabel,
                    customerName,
                    expectedFilenames,
                    matched,
                    matchedFile
                };
                
                status.expectedRoutes.push(routeInfo);
                
                if (matched) {
                    status.matchedRoutes.push(routeInfo);
                } else {
                    status.unmatchedRoutes.push(routeInfo);
                }
            }
        }
        
        // Find orphan Excel files (not in CSV)
        const matchedFileNames = status.matchedRoutes.map(r => r.matchedFile);
        status.orphanFiles = xlsxFiles.filter(f => !matchedFileNames.includes(f));
        
        res.json(status);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get route status',
            message: error.message
        });
    }
});

// API endpoint to list files in route_data directory
app.get('/api/files', async (req, res) => {
    try {
        const routeDataPath = path.resolve(ROUTE_DATA_PATH);
        
        try {
            await fs.access(routeDataPath);
        } catch {
            return res.json({
                error: 'Route data directory does not exist',
                path: routeDataPath,
                files: []
            });
        }
        
        const files = await fs.readdir(routeDataPath);
        const fileDetails = [];
        
        for (const file of files) {
            const filePath = path.join(routeDataPath, file);
            const stats = await fs.stat(filePath);
            
            fileDetails.push({
                name: file,
                size: stats.size,
                extension: path.extname(file),
                isDirectory: stats.isDirectory(),
                modified: stats.mtime
            });
        }
        
        res.json({
            path: routeDataPath,
            totalFiles: fileDetails.length,
            files: fileDetails,
            xlsxFiles: fileDetails.filter(f => f.extension === '.xlsx').map(f => f.name),
            csvFiles: fileDetails.filter(f => f.extension === '.csv').map(f => f.name)
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to list files',
            message: error.message
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        config: {
            overpassUrl: OVERPASS_API_URL,
            weatherEnabled: !!OPENWEATHER_API_KEY,
            cacheEnabled: ENABLE_CACHE,
            routeDataPath: ROUTE_DATA_PATH
        }
    });
});

// Create route_data directory if it doesn't exist
async function ensureRouteDataDirectory() {
    const routeDataPath = path.resolve(ROUTE_DATA_PATH);
    try {
        await fs.access(routeDataPath);
        log('info', chalk.green('✓ Route data directory exists'), { path: routeDataPath });
    } catch {
        await fs.mkdir(routeDataPath, { recursive: true });
        log('info', chalk.yellow('✓ Created route_data directory'), { path: routeDataPath });
    }
}

// Start server
app.listen(PORT, async () => {
    console.clear();
    log('info', chalk.cyan('================================='));
    log('info', chalk.cyan('   Route Management System v1.0  '));
    log('info', chalk.cyan('================================='));
    log('info', chalk.green(`✓ Server running on http://localhost:${PORT}`));
    log('info', chalk.green(`✓ Using Overpass API at: ${OVERPASS_API_URL}`));
    log('info', chalk.green(`✓ Route data directory: ${path.resolve(ROUTE_DATA_PATH)}`));
    log('info', chalk.green(`✓ Weather API: ${OPENWEATHER_API_KEY ? 'Configured' : 'Not configured (weather disabled)'}`));
    log('info', chalk.cyan('=================================\n'));
    
    await ensureRouteDataDirectory();
});