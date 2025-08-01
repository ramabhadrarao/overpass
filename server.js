require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const XLSX = require('xlsx');
const axios = require('axios');
const chalk = require('chalk');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const ROUTE_DATA_PATH = process.env.ROUTE_DATA_PATH || './route_data';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/route_management2';

// API Keys
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const OVERPASS_API_URL = process.env.OVERPASS_API_URL || 'http://43.250.40.133:8080/api/interpreter';
const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;
const HERE_API_KEY = process.env.HERE_API_KEY;
const MAPBOX_API_KEY = process.env.MAPBOX_API_KEY;

// MongoDB variables
let db;
let client;

// Default admin credentials
const DEFAULT_ADMIN = {
    username: 'admin',
    password: 'admin123',
    role: 'admin'
};

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
    errors: [],
    startTime: null,
    endTime: null,
    statistics: {
        totalWithCoordinates: 0,
        totalWithoutCoordinates: 0,
        totalWaypoints: 0,
        totalDistance: 0,
        averageWaypoints: 0,
        processingTime: 0
    }
};

// MongoDB connection
async function connectToMongoDB() {
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        
        // Create indexes
        await db.collection('routes').createIndex({ routeId: 1 });
        await db.collection('api_logs').createIndex({ timestamp: -1 });
        await db.collection('api_logs').createIndex({ userId: 1 });
        
        // Create default admin user if not exists
        const usersCollection = db.collection('users');
        const adminExists = await usersCollection.findOne({ username: DEFAULT_ADMIN.username });
        if (!adminExists) {
            await usersCollection.insertOne({
                ...DEFAULT_ADMIN,
                createdAt: new Date(),
                lastLogin: null
            });
            log('info', chalk.green('✓ Default admin user created'));
        }
        
        log('info', chalk.green('✓ Connected to MongoDB'));
    } catch (error) {
        log('error', 'Failed to connect to MongoDB', { error: error.message });
        process.exit(1);
    }
}

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

// Log API calls to MongoDB
async function logAPICall(apiName, endpoint, params, response, userId = 'system') {
    try {
        await db.collection('api_logs').insertOne({
            apiName,
            endpoint,
            params,
            response: response ? { status: response.status, data: response.data ? 'success' : 'failed' } : null,
            userId,
            timestamp: new Date(),
            ip: params.ip || 'internal'
        });
    } catch (error) {
        log('error', 'Failed to log API call', { error: error.message });
    }
}

// Save route to MongoDB
async function saveRouteToMongoDB(routeData) {
    try {
        const routesCollection = db.collection('routes');
        
        // Check if route exists
        const existingRoute = await routesCollection.findOne({ routeId: routeData.routeId });
        
        if (existingRoute) {
            // Update existing route
            await routesCollection.updateOne(
                { routeId: routeData.routeId },
                { 
                    $set: {
                        ...routeData,
                        updatedAt: new Date()
                    }
                }
            );
            log('info', `Updated route ${routeData.routeId} in MongoDB`);
        } else {
            // Insert new route
            await routesCollection.insertOne({
                ...routeData,
                createdAt: new Date(),
                updatedAt: new Date()
            });
            log('info', `Saved new route ${routeData.routeId} to MongoDB`);
        }
    } catch (error) {
        log('error', 'Failed to save route to MongoDB', { error: error.message });
    }
}

// Cache helper functions
function getCacheKey(routeId) {
    return `route_${routeId}`;
}

function isCacheValid(key) {
    const ENABLE_CACHE = process.env.ENABLE_CACHE === 'true';
    const CACHE_TTL = parseInt(process.env.CACHE_TTL || '3600');
    
    if (!ENABLE_CACHE) return false;
    const timestamp = cacheTimestamps[key];
    if (!timestamp) return false;
    return (Date.now() - timestamp) < (CACHE_TTL * 1000);
}

function setCache(key, data) {
    const ENABLE_CACHE = process.env.ENABLE_CACHE === 'true';
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
            if (values.length >= headers.length && values.some(v => v)) {
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

// Reverse geocoding function
async function reverseGeocode(lat, lng) {
    try {
        if (!MAPBOX_API_KEY) {
            return 'Address not available';
        }
        
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_API_KEY}`;
        const response = await axios.get(url, { timeout: 5000 });
        
        await logAPICall('Mapbox', 'reverseGeocode', { lat, lng }, response);
        
        if (response.data.features && response.data.features.length > 0) {
            return response.data.features[0].place_name;
        }
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    } catch (error) {
        log('error', 'Reverse geocoding failed', { error: error.message });
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
}

// Generate Google Maps link
function getGoogleMapsLink(lat, lng) {
    return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Check if location is petrol pump
async function checkPetrolPump(lat, lng) {
    try {
        const query = `[out:json][timeout:25];
(
  node["amenity"="fuel"](around:500,${lat},${lng});
  way["amenity"="fuel"](around:500,${lat},${lng});
);
out center;`;
        
        const response = await axios.post(
            OVERPASS_API_URL,
            `data=${encodeURIComponent(query)}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000
            }
        );
        
        await logAPICall('Overpass', 'checkPetrolPump', { lat, lng }, response);
        
        return response.data.elements && response.data.elements.length > 0;
    } catch (error) {
        log('error', 'Error checking petrol pump', { error: error.message });
        return false;
    }
}

// Get weather data
async function getWeatherData(lat, lng) {
    try {
        if (!OPENWEATHER_API_KEY) {
            return null;
        }
        
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_API_KEY}&units=metric`;
        const response = await axios.get(url, { timeout: 5000 });
        
        await logAPICall('OpenWeather', 'weather', { lat, lng }, response);
        
        return {
            temperature: response.data.main.temp,
            description: response.data.weather[0].description,
            humidity: response.data.main.humidity,
            windSpeed: response.data.wind.speed
        };
    } catch (error) {
        log('error', 'Error fetching weather', { error: error.message });
        return null;
    }
}

// Get traffic data from TomTom
async function getTrafficData(coordinates) {
    try {
        if (!TOMTOM_API_KEY || coordinates.length < 2) {
            return [];
        }
        
        const trafficData = [];
        const sampleInterval = Math.max(1, Math.floor(coordinates.length / 20));
        
        for (let i = 0; i < coordinates.length - 1; i += sampleInterval) {
            const coord = coordinates[i];
            const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${coord.lat},${coord.lng}&key=${TOMTOM_API_KEY}`;
            
            try {
                const response = await axios.get(url, { timeout: 5000 });
                await logAPICall('TomTom', 'traffic', { lat: coord.lat, lng: coord.lng }, response);
                
                if (response.data.flowSegmentData) {
                    const data = response.data.flowSegmentData;
                    trafficData.push({
                        lat: coord.lat,
                        lng: coord.lng,
                        currentSpeed: data.currentSpeed,
                        freeFlowSpeed: data.freeFlowSpeed,
                        confidence: data.confidence,
                        congestionLevel: ((data.freeFlowSpeed - data.currentSpeed) / data.freeFlowSpeed * 100).toFixed(1)
                    });
                }
            } catch (err) {
                log('debug', 'Traffic data not available for point', { lat: coord.lat, lng: coord.lng });
            }
        }
        
        return trafficData;
    } catch (error) {
        log('error', 'Error fetching traffic data', { error: error.message });
        return [];
    }
}

// Detect sharp turns
function detectSharpTurns(coordinates) {
    const sharpTurns = [];
    const sharpTurnThreshold = 60;
    
    for (let i = 1; i < coordinates.length - 1; i++) {
        const p1 = coordinates[i - 1];
        const p2 = coordinates[i];
        const p3 = coordinates[i + 1];
        
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

// Calculate distance between two points
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Calculate total distance
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

// Middleware to check API permissions
async function checkAPIPermission(req, res, next) {
    const apiName = req.query.apiName || req.body.apiName;
    const userId = req.headers['x-user-id'] || 'guest';
    
    // List of APIs that require permission (excluding Overpass)
    const restrictedAPIs = ['weather', 'traffic', 'geocoding'];
    
    if (restrictedAPIs.includes(apiName)) {
        // Check if user has confirmed permission
        const permission = req.headers['x-api-permission'] === 'confirmed';
        
        if (!permission) {
            return res.status(403).json({
                error: 'API permission required',
                message: `This action requires ${apiName} API access. Please confirm in the frontend.`,
                requiresConfirmation: true
            });
        }
    }
    
    next();
}

// API Endpoints

// Test Overpass connection
app.get('/api/test-overpass', async (req, res) => {
    try {
        const testQuery = '[out:json];node[name="Mumbai"];out;';
        const response = await axios.post(
            OVERPASS_API_URL,
            `data=${encodeURIComponent(testQuery)}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000
            }
        );
        
        await logAPICall('Overpass', 'test', {}, response);
        
        res.json({
            success: true,
            message: 'Overpass API is accessible',
            overpassUrl: OVERPASS_API_URL,
            testResult: response.data
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

// Get progress
app.get('/api/progress', (req, res) => {
    res.json(processProgress);
});

// Get all routes
app.get('/api/routes', async (req, res) => {
    try {
        processProgress = {
            status: 'processing',
            totalRoutes: 0,
            processedRoutes: 0,
            currentRoute: '',
            errors: [],
            startTime: new Date(),
            endTime: null,
            statistics: {
                totalWithCoordinates: 0,
                totalWithoutCoordinates: 0,
                totalWaypoints: 0,
                totalDistance: 0,
                averageWaypoints: 0,
                processingTime: 0
            }
        };
        
        const routeDataPath = path.resolve(ROUTE_DATA_PATH);
        
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
        let totalWaypoints = 0;
        let totalDistance = 0;
        
        // Process routes from CSV
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
                
                // Generate possible filenames
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
                        matchedRoutes++;
                        break;
                    }
                }
                
                if (!foundFile) {
                    missingRoutes++;
                }
                
                // Create route entry
                const routeId = foundFile || `pending_${buCode}_${rowLabel}`;
                const routeData = {
                    id: routeId,
                    routeId: routeId,
                    depotCode: buCode,
                    consumerCode: rowLabel,
                    customerName: customerName,
                    location: location,
                    filename: foundFile || 'No file found',
                    totalSteps: coordinates.length,
                    hasCoordinates: coordinates.length > 0,
                    startLocation: coordinates.length > 0 ? {
                        lat: coordinates[0].lat,
                        lng: coordinates[0].lng
                    } : null,
                    endLocation: coordinates.length > 0 ? {
                        lat: coordinates[coordinates.length - 1].lat,
                        lng: coordinates[coordinates.length - 1].lng
                    } : null
                };
                
                if (coordinates.length > 0) {
                    totalWaypoints += coordinates.length;
                    const distance = parseFloat(calculateTotalDistance(coordinates));
                    totalDistance += distance;
                    routeData.totalDistance = distance;
                    
                    processProgress.statistics.totalWithCoordinates++;
                } else {
                    routeData.expectedFilenames = possibleFilenames;
                    processProgress.errors.push(`Missing file for route: ${buCode}_${rowLabel}`);
                    processProgress.statistics.totalWithoutCoordinates++;
                }
                
                // Save basic route info to MongoDB
                await saveRouteToMongoDB(routeData);
                
                routes.push(routeData);
            }
        }
        
        // Update statistics
        processProgress.endTime = new Date();
        processProgress.statistics.totalWaypoints = totalWaypoints;
        processProgress.statistics.totalDistance = totalDistance;
        processProgress.statistics.averageWaypoints = matchedRoutes > 0 ? Math.round(totalWaypoints / matchedRoutes) : 0;
        processProgress.statistics.processingTime = (processProgress.endTime - processProgress.startTime) / 1000;
        
        // Summary
        log('info', chalk.cyan('\n=== Processing Complete ==='));
        log('info', chalk.green(`✓ Total routes in CSV: ${totalCsvRoutes}`));
        log('info', chalk.green(`✓ Routes with Excel files: ${matchedRoutes}`));
        log('warn', chalk.yellow(`⚠ Routes missing Excel files: ${missingRoutes}`));
        log('info', chalk.blue(`📊 Success rate: ${((matchedRoutes/totalCsvRoutes)*100).toFixed(1)}%`));
        log('info', chalk.blue(`📍 Total waypoints: ${totalWaypoints}`));
        log('info', chalk.blue(`🛣️ Total distance: ${totalDistance.toFixed(2)} km`));
        log('info', chalk.blue(`⏱️ Processing time: ${processProgress.statistics.processingTime.toFixed(2)} seconds\n`));
        
        processProgress.status = 'complete';
        res.json(routes);
    } catch (error) {
        log('error', 'Error getting routes', { error: error.message });
        processProgress.status = 'error';
        processProgress.errors.push(error.message);
        res.status(500).json({ error: 'Failed to fetch routes' });
    }
});

// Get route details with enhanced analysis
app.get('/api/routes/:routeId', checkAPIPermission, async (req, res) => {
    try {
        const { routeId } = req.params;
        const enhancedAnalysis = req.query.enhanced === 'true';
        const cacheKey = getCacheKey(routeId);
        
        // Check cache first
        if (isCacheValid(cacheKey) && !enhancedAnalysis) {
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
        
        // Basic route analysis
        const [isStartPetrolPump, isEndPetrolPump] = await Promise.all([
            checkPetrolPump(startCoord.lat, startCoord.lng),
            checkPetrolPump(endCoord.lat, endCoord.lng)
        ]);
        
        const sharpTurns = detectSharpTurns(coordinates);
        
        // Get weather data if API key is available
        let startWeather = null, endWeather = null;
        if (req.headers['x-api-permission'] === 'confirmed') {
            [startWeather, endWeather] = await Promise.all([
                getWeatherData(startCoord.lat, startCoord.lng),
                getWeatherData(endCoord.lat, endCoord.lng)
            ]);
        }
        
        const routeDetails = {
            routeInfo: {
                depotCode: routeId.split('_')[0] || 'Unknown',
                consumerCode: routeId.split('_')[1]?.replace('.xlsx', '') || 'Unknown',
                filename: routeId
            },
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
            sharpTurns: sharpTurns,
            totalDistance: calculateTotalDistance(coordinates),
            bounds: {
                north: Math.max(...coordinates.map(c => c.lat)),
                south: Math.min(...coordinates.map(c => c.lat)),
                east: Math.max(...coordinates.map(c => c.lng)),
                west: Math.min(...coordinates.map(c => c.lng))
            }
        };
        
        // Enhanced analysis if requested
        if (enhancedAnalysis && req.headers['x-api-permission'] === 'confirmed') {
            log('info', '🔍 Performing enhanced analysis...');
            
            // Get traffic data
            const trafficData = await getTrafficData(coordinates);
            
            // Simulate other enhanced features
            routeDetails.enhancedAnalysis = {
                trafficData: trafficData,
                accidentProneAreas: sharpTurns.map(turn => ({
                    ...turn,
                    riskLevel: turn.angle > 90 ? 'high' : 'medium',
                    address: `Near waypoint ${turn.index}`
                })),
                blindSpots: [], // Would require additional data
                ecoSensitiveZones: [], // Would require environmental database
                emergencyServices: [], // Would require emergency services API
                networkCoverage: [], // Would require network coverage API
                roadConditions: [] // Would require road conditions API
            };
        }
        
        // Save complete route details to MongoDB
        await saveRouteToMongoDB({
            routeId: routeId,
            ...routeDetails,
            analysisDate: new Date()
        });
        
        // Cache the result
        if (!enhancedAnalysis) {
            setCache(cacheKey, routeDetails);
        }
        
        res.json(routeDetails);
    } catch (error) {
        log('error', 'Error getting route details', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch route details' });
    }
});

// Get API logs
app.get('/api/logs', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const logs = await db.collection('api_logs')
            .find({})
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
        
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// Get routes from MongoDB
app.get('/api/db/routes', async (req, res) => {
    try {
        const routes = await db.collection('routes')
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json(routes);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch routes from database' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mongodb: client ? 'connected' : 'disconnected',
        config: {
            overpassUrl: OVERPASS_API_URL,
            weatherEnabled: !!OPENWEATHER_API_KEY,
            trafficEnabled: !!TOMTOM_API_KEY,
            geocodingEnabled: !!MAPBOX_API_KEY,
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

// Graceful shutdown
process.on('SIGINT', async () => {
    log('info', chalk.yellow('\n🛑 Shutting down gracefully...'));
    
    if (client) {
        await client.close();
        log('info', chalk.green('✓ MongoDB connection closed'));
    }
    
    process.exit(0);
});

// Start server
app.listen(PORT, async () => {
    console.clear();
    log('info', chalk.cyan('================================='));
    log('info', chalk.cyan('   Route Management System v2.0  '));
    log('info', chalk.cyan('================================='));
    log('info', chalk.green(`✓ Server running on http://localhost:${PORT}`));
    log('info', chalk.green(`✓ MongoDB URI: ${MONGODB_URI}`));
    log('info', chalk.green(`✓ Default admin: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`));
    log('info', chalk.green(`✓ Using Overpass API at: ${OVERPASS_API_URL}`));
    log('info', chalk.green(`✓ Route data directory: ${path.resolve(ROUTE_DATA_PATH)}`));
    log('info', chalk.cyan('=================================\n'));
    
    await ensureRouteDataDirectory();
    await connectToMongoDB();
});