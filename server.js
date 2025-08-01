require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const XLSX = require('xlsx');
const axios = require('axios');
const chalk = require('chalk');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const ROUTE_DATA_PATH = process.env.ROUTE_DATA_PATH || './route_data';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/route_management';

// API Keys
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const OVERPASS_API_URL = process.env.OVERPASS_API_URL || 'http://43.250.40.133:8080/api/interpreter';
const TOMTOM_API_KEY = process.env.TOMTOM_API_KEY;
const HERE_API_KEY = process.env.HERE_API_KEY;
const MAPBOX_API_KEY = process.env.MAPBOX_API_KEY;

// MongoDB variables
let db;
let client;

// Collections
const COLLECTIONS = {
    ROUTES: 'routes',
    SHARP_TURNS: 'sharp_turns',
    ACCIDENT_PRONE_AREAS: 'accident_prone_areas',
    BLIND_SPOTS: 'blind_spots',
    ECO_SENSITIVE_ZONES: 'eco_sensitive_zones',
    EMERGENCY_SERVICES: 'emergency_services',
    NETWORK_COVERAGES: 'network_coverages',
    ROAD_CONDITIONS: 'road_conditions',
    TRAFFIC_DATA: 'traffic_data',
    WEATHER_CONDITIONS: 'weather_conditions',
    USERS: 'users',
    API_LOGS: 'api_logs'
};

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

// Progress tracking
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

// Enhanced logging
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

// MongoDB connection
async function connectToMongoDB() {
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        
        // Create indexes for all collections
        await createIndexes();
        
        // Create default admin user if not exists
        const usersCollection = db.collection(COLLECTIONS.USERS);
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

// Create indexes for all collections
async function createIndexes() {
    // Routes indexes
    await db.collection(COLLECTIONS.ROUTES).createIndex({ routeName: 1 });
    await db.collection(COLLECTIONS.ROUTES).createIndex({ fromCode: 1, toCode: 1 });
    await db.collection(COLLECTIONS.ROUTES).createIndex({ createdAt: -1 });
    
    // Location-based indexes for all collections with coordinates
    const locationCollections = [
        COLLECTIONS.SHARP_TURNS,
        COLLECTIONS.ACCIDENT_PRONE_AREAS,
        COLLECTIONS.BLIND_SPOTS,
        COLLECTIONS.ECO_SENSITIVE_ZONES,
        COLLECTIONS.EMERGENCY_SERVICES,
        COLLECTIONS.NETWORK_COVERAGES,
        COLLECTIONS.ROAD_CONDITIONS,
        COLLECTIONS.TRAFFIC_DATA,
        COLLECTIONS.WEATHER_CONDITIONS
    ];
    
    for (const collection of locationCollections) {
        await db.collection(collection).createIndex({ routeId: 1 });
        await db.collection(collection).createIndex({ location: '2dsphere' });
        await db.collection(collection).createIndex({ riskScore: -1 });
    }
    
    // API logs indexes
    await db.collection(COLLECTIONS.API_LOGS).createIndex({ timestamp: -1 });
    await db.collection(COLLECTIONS.API_LOGS).createIndex({ userId: 1 });
    
    log('info', '✓ Database indexes created');
}

// Log API calls to MongoDB
async function logAPICall(apiName, endpoint, params, response, userId = 'system') {
    try {
        await db.collection(COLLECTIONS.API_LOGS).insertOne({
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
            
            const coordinates = data.map(row => ({
                lat: parseFloat(row.Latitude || row.latitude || row.LAT || row.lat || 0),
                lng: parseFloat(row.Longitude || row.longitude || row.LON || row.lng || row.lon || 0),
                stepId: row.Step_ID || row.step_id || null,
                ...row
            })).filter(coord => coord.lat && coord.lng);
            
            if (coordinates.length > 0 && coordinates[0].stepId) {
                coordinates.sort((a, b) => parseInt(a.stepId) - parseInt(b.stepId));
            }
            
            return coordinates;
        }
        
        return [];
    } catch (error) {
        log('error', `Error parsing file ${filePath}:`, { error: error.message });
        return [];
    }
}

// Function to parse CSV route info
async function parseRouteCSV(csvPath) {
    try {
        const fileContent = await fs.readFile(csvPath, 'utf8');
        const lines = fileContent.split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        
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
        
        return routes;
    } catch (error) {
        log('error', 'Error parsing CSV:', { error: error.message });
        return [];
    }
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
    
    return totalDistance;
}

// Reverse geocoding
async function reverseGeocode(lat, lng) {
    try {
        if (!MAPBOX_API_KEY) {
            return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        }
        
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${MAPBOX_API_KEY}`;
        const response = await axios.get(url, { timeout: 5000 });
        
        await logAPICall('Mapbox', 'reverseGeocode', { lat, lng }, response);
        
        if (response.data.features && response.data.features.length > 0) {
            return response.data.features[0].place_name;
        }
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    } catch (error) {
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
}

// Overpass API query
async function queryOverpass(query) {
    try {
        const response = await axios.post(
            OVERPASS_API_URL,
            `data=${encodeURIComponent(query)}`,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000
            }
        );
        return response.data;
    } catch (error) {
        log('error', 'Overpass API error', { error: error.message });
        throw error;
    }
}

// Analyze sharp turns and save to MongoDB
async function analyzeAndSaveSharpTurns(routeId, coordinates) {
    const sharpTurns = [];
    const sharpTurnThreshold = 60;
    let cumulativeDistance = 0;
    
    for (let i = 1; i < coordinates.length - 1; i++) {
        const p1 = coordinates[i - 1];
        const p2 = coordinates[i];
        const p3 = coordinates[i + 1];
        
        // Calculate distance from start
        cumulativeDistance += calculateDistance(p1.lat, p1.lng, p2.lat, p2.lng);
        
        const bearing1 = calculateBearing(p1.lat, p1.lng, p2.lat, p2.lng);
        const bearing2 = calculateBearing(p2.lat, p2.lng, p3.lat, p3.lng);
        
        let turnAngle = Math.abs(bearing2 - bearing1);
        if (turnAngle > 180) turnAngle = 360 - turnAngle;
        
        if (turnAngle > sharpTurnThreshold) {
            const direction = bearing2 > bearing1 ? 'right' : 'left';
            const riskScore = turnAngle > 90 ? 9 : turnAngle > 75 ? 7 : 5;
            
            const sharpTurn = {
                routeId: new ObjectId(routeId),
                location: {
                    type: "Point",
                    coordinates: [p2.lng, p2.lat]
                },
                latitude: p2.lat,
                longitude: p2.lng,
                turnAngle: turnAngle,
                turnRadius: 50, // Default estimate
                direction: direction,
                riskScore: riskScore,
                distanceFromStartKm: cumulativeDistance,
                approachSpeed: 60, // Default estimate
                recommendedSpeed: turnAngle > 90 ? 20 : 30,
                visibility: turnAngle > 90 ? 'poor' : 'moderate',
                warningSignsPresent: false,
                guardrailsPresent: false,
                driverActionRequired: `Reduce speed to ${turnAngle > 90 ? 20 : 30} km/h for sharp ${direction} turn`,
                createdAt: new Date()
            };
            
            sharpTurns.push(sharpTurn);
        }
    }
    
    // Save to MongoDB
    if (sharpTurns.length > 0) {
        await db.collection(COLLECTIONS.SHARP_TURNS).insertMany(sharpTurns);
        log('info', `Saved ${sharpTurns.length} sharp turns for route ${routeId}`);
    }
    
    return sharpTurns;
}

// Get emergency services from Overpass and save to MongoDB
async function getAndSaveEmergencyServices(routeId, coordinates) {
    try {
        const lats = coordinates.map(c => c.lat);
        const lngs = coordinates.map(c => c.lng);
        const minLat = Math.min(...lats) - 0.05;
        const maxLat = Math.max(...lats) + 0.05;
        const minLng = Math.min(...lngs) - 0.05;
        const maxLng = Math.max(...lngs) + 0.05;
        
        const query = `[out:json][timeout:30];
(
  node["amenity"="hospital"](${minLat},${minLng},${maxLat},${maxLng});
  way["amenity"="hospital"](${minLat},${minLng},${maxLat},${maxLng});
  node["amenity"="police"](${minLat},${minLng},${maxLat},${maxLng});
  way["amenity"="police"](${minLat},${minLng},${maxLat},${maxLng});
  node["amenity"="fire_station"](${minLat},${minLng},${maxLat},${maxLng});
  way["amenity"="fire_station"](${minLat},${minLng},${maxLat},${maxLng});
  node["amenity"="fuel"](${minLat},${minLng},${maxLat},${maxLng});
  way["amenity"="fuel"](${minLat},${minLng},${maxLat},${maxLng});
  node["amenity"="school"](${minLat},${minLng},${maxLat},${maxLng});
  way["amenity"="school"](${minLat},${minLng},${maxLat},${maxLng});
);
out center;`;
        
        const data = await queryOverpass(query);
        
        if (!data.elements || data.elements.length === 0) return [];
        
        const emergencyServices = [];
        
        for (const element of data.elements) {
            const lat = element.lat || element.center?.lat;
            const lng = element.lon || element.center?.lon;
            
            if (!lat || !lng) continue;
            
            // Find nearest point on route
            let minDistance = Infinity;
            let nearestPoint = null;
            
            for (const coord of coordinates) {
                const distance = calculateDistance(lat, lng, coord.lat, coord.lng);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestPoint = coord;
                }
            }
            
            const serviceType = element.tags.amenity === 'police' ? 'police' :
                              element.tags.amenity === 'hospital' ? 'hospital' :
                              element.tags.amenity === 'fire_station' ? 'fire_station' :
                              element.tags.amenity === 'fuel' ? 'fuel' :
                              element.tags.amenity === 'school' ? 'school' : 'other';
            
            const service = {
                routeId: new ObjectId(routeId),
                location: {
                    type: "Point",
                    coordinates: [lng, lat]
                },
                latitude: lat,
                longitude: lng,
                serviceType: serviceType,
                name: element.tags.name || `${serviceType.charAt(0).toUpperCase() + serviceType.slice(1).replace('_', ' ')}`,
                address: element.tags['addr:full'] || element.tags['addr:street'] || 
                        await reverseGeocode(lat, lng),
                phone: element.tags.phone || element.tags['contact:phone'] || 'Not available',
                distanceFromRouteKm: minDistance,
                createdAt: new Date()
            };
            
            emergencyServices.push(service);
        }
        
        // Save to MongoDB
        if (emergencyServices.length > 0) {
            await db.collection(COLLECTIONS.EMERGENCY_SERVICES).insertMany(emergencyServices);
            log('info', `Saved ${emergencyServices.length} emergency services for route ${routeId}`);
        }
        
        return emergencyServices;
    } catch (error) {
        log('error', 'Error fetching emergency services', { error: error.message });
        return [];
    }
}

// Analyze road conditions from OSM data
async function analyzeAndSaveRoadConditions(routeId, coordinates) {
    try {
        const roadConditions = [];
        const sampleInterval = Math.max(1, Math.floor(coordinates.length / 20));
        
        for (let i = 0; i < coordinates.length; i += sampleInterval) {
            const coord = coordinates[i];
            
            // Query OSM for road information
            const query = `[out:json][timeout:25];
way(around:50,${coord.lat},${coord.lng})["highway"];
out tags;`;
            
            try {
                const data = await queryOverpass(query);
                
                if (data.elements && data.elements.length > 0) {
                    const road = data.elements[0];
                    const highway = road.tags?.highway || 'unclassified';
                    const surface = road.tags?.surface || 'unknown';
                    const lanes = parseInt(road.tags?.lanes) || 2;
                    const maxspeed = parseInt(road.tags?.maxspeed) || 60;
                    
                    // Determine surface quality based on OSM tags
                    let surfaceQuality = 'good';
                    let riskScore = 3;
                    
                    if (surface === 'unpaved' || surface === 'dirt' || surface === 'gravel') {
                        surfaceQuality = 'poor';
                        riskScore = 7;
                    } else if (surface === 'compacted' || surface === 'fine_gravel') {
                        surfaceQuality = 'moderate';
                        riskScore = 5;
                    }
                    
                    // Check for construction
                    const underConstruction = road.tags?.construction ? true : false;
                    if (underConstruction) {
                        riskScore = 8;
                        surfaceQuality = 'critical';
                    }
                    
                    const condition = {
                        routeId: new ObjectId(routeId),
                        location: {
                            type: "Point",
                            coordinates: [coord.lng, coord.lat]
                        },
                        latitude: coord.lat,
                        longitude: coord.lng,
                        surfaceQuality: surfaceQuality,
                        roadType: highway,
                        width: lanes * 3.5, // Estimate based on lanes
                        surface: surface,
                        lanes: lanes,
                        maxSpeed: maxspeed,
                        underConstruction: underConstruction,
                        riskScore: riskScore,
                        createdAt: new Date()
                    };
                    
                    roadConditions.push(condition);
                }
            } catch (err) {
                log('debug', 'Could not fetch road data for point', { lat: coord.lat, lng: coord.lng });
            }
        }
        
        // Save to MongoDB
        if (roadConditions.length > 0) {
            await db.collection(COLLECTIONS.ROAD_CONDITIONS).insertMany(roadConditions);
            log('info', `Saved ${roadConditions.length} road conditions for route ${routeId}`);
        }
        
        return roadConditions;
    } catch (error) {
        log('error', 'Error analyzing road conditions', { error: error.message });
        return [];
    }
}

// Get traffic data from TomTom
async function getAndSaveTrafficData(routeId, coordinates) {
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
                    const congestionLevel = ((data.freeFlowSpeed - data.currentSpeed) / data.freeFlowSpeed * 100);
                    
                    let congestionCategory = 'free_flow';
                    let riskScore = 2;
                    
                    if (congestionLevel > 50) {
                        congestionCategory = 'heavy';
                        riskScore = 8;
                    } else if (congestionLevel > 30) {
                        congestionCategory = 'moderate';
                        riskScore = 5;
                    }
                    
                    const traffic = {
                        routeId: new ObjectId(routeId),
                        location: {
                            type: "Point",
                            coordinates: [coord.lng, coord.lat]
                        },
                        latitude: coord.lat,
                        longitude: coord.lng,
                        congestionLevel: congestionCategory,
                        congestionPercentage: congestionLevel.toFixed(1),
                        currentSpeedKmph: data.currentSpeed,
                        freeFlowSpeedKmph: data.freeFlowSpeed,
                        averageSpeedKmph: data.currentSpeed,
                        confidence: data.confidence,
                        riskScore: riskScore,
                        createdAt: new Date()
                    };
                    
                    trafficData.push(traffic);
                }
            } catch (err) {
                log('debug', 'Traffic data not available for point', { lat: coord.lat, lng: coord.lng });
            }
        }
        
        // Save to MongoDB
        if (trafficData.length > 0) {
            await db.collection(COLLECTIONS.TRAFFIC_DATA).insertMany(trafficData);
            log('info', `Saved ${trafficData.length} traffic data points for route ${routeId}`);
        }
        
        return trafficData;
    } catch (error) {
        log('error', 'Error fetching traffic data', { error: error.message });
        return [];
    }
}

// Get weather data
async function getAndSaveWeatherData(routeId, coordinates) {
    try {
        if (!OPENWEATHER_API_KEY) {
            return [];
        }
        
        const weatherData = [];
        const sampleInterval = Math.max(1, Math.floor(coordinates.length / 10));
        
        for (let i = 0; i < coordinates.length; i += sampleInterval) {
            const coord = coordinates[i];
            const url = `https://api.openweathermap.org/data/2.5/weather?lat=${coord.lat}&lon=${coord.lng}&appid=${OPENWEATHER_API_KEY}&units=metric`;
            
            try {
                const response = await axios.get(url, { timeout: 5000 });
                await logAPICall('OpenWeather', 'weather', { lat: coord.lat, lng: coord.lng }, response);
                
                const data = response.data;
                const weatherMain = data.weather[0].main.toLowerCase();
                
                let riskScore = 3;
                let challenges = [];
                let driverCaution = [];
                
                // Determine risk based on weather
                if (weatherMain.includes('rain') || weatherMain.includes('drizzle')) {
                    riskScore = 6;
                    challenges.push('Wet roads', 'Reduced visibility');
                    driverCaution.push('Reduce speed', 'Increase following distance');
                } else if (weatherMain.includes('storm') || weatherMain.includes('thunder')) {
                    riskScore = 9;
                    challenges.push('Heavy rain', 'Lightning', 'Strong winds');
                    driverCaution.push('Avoid travel if possible', 'Find safe shelter');
                } else if (weatherMain.includes('fog') || weatherMain.includes('mist')) {
                    riskScore = 7;
                    challenges.push('Poor visibility');
                    driverCaution.push('Use fog lights', 'Drive slowly');
                } else if (weatherMain.includes('snow')) {
                    riskScore = 8;
                    challenges.push('Slippery roads', 'Poor visibility');
                    driverCaution.push('Use chains if required', 'Drive very slowly');
                }
                
                // Determine season (simplified)
                const month = new Date().getMonth();
                let season = 'Winter';
                if (month >= 2 && month <= 4) season = 'Summer';
                else if (month >= 5 && month <= 8) season = 'Monsoon';
                else if (month >= 9 && month <= 10) season = 'Post-Monsoon';
                
                const weather = {
                    routeId: new ObjectId(routeId),
                    location: {
                        type: "Point",
                        coordinates: [coord.lng, coord.lat]
                    },
                    latitude: coord.lat,
                    longitude: coord.lng,
                    season: season,
                    currentWeather: data.weather[0].description,
                    temperature: data.main.temp,
                    humidity: data.main.humidity,
                    windSpeed: data.wind.speed,
                    visibility: data.visibility || 10000,
                    challenges: challenges,
                    driverCaution: driverCaution,
                    riskScore: riskScore,
                    createdAt: new Date()
                };
                
                weatherData.push(weather);
            } catch (err) {
                log('debug', 'Weather data not available for point', { lat: coord.lat, lng: coord.lng });
            }
        }
        
        // Save to MongoDB
        if (weatherData.length > 0) {
            await db.collection(COLLECTIONS.WEATHER_CONDITIONS).insertMany(weatherData);
            log('info', `Saved ${weatherData.length} weather data points for route ${routeId}`);
        }
        
        return weatherData;
    } catch (error) {
        log('error', 'Error fetching weather data', { error: error.message });
        return [];
    }
}

// Analyze network coverage (simulated)
async function analyzeAndSaveNetworkCoverage(routeId, coordinates) {
    const networkData = [];
    const sampleInterval = Math.max(1, Math.floor(coordinates.length / 15));
    let cumulativeDistance = 0;
    
    for (let i = 0; i < coordinates.length; i += sampleInterval) {
        if (i > 0) {
            cumulativeDistance += calculateDistance(
                coordinates[i-sampleInterval].lat, 
                coordinates[i-sampleInterval].lng,
                coordinates[i].lat, 
                coordinates[i].lng
            ) * sampleInterval;
        }
        
        const coord = coordinates[i];
        
        // Simulate network coverage based on location
        // In real implementation, this would use actual network coverage APIs
        const isRemote = Math.random() > 0.8; // 20% chance of being remote
        const signalStrength = isRemote ? Math.floor(Math.random() * 2) : Math.floor(Math.random() * 3) + 2;
        const isDeadZone = signalStrength === 0;
        
        const coverage = {
            routeId: new ObjectId(routeId),
            location: {
                type: "Point",
                coordinates: [coord.lng, coord.lat]
            },
            latitude: coord.lat,
            longitude: coord.lng,
            isDeadZone: isDeadZone,
            signalStrength: signalStrength,
            signalCategory: signalStrength === 0 ? 'no_signal' : 
                           signalStrength <= 2 ? 'weak' : 'good',
            communicationRisk: isDeadZone ? 'high' : signalStrength <= 2 ? 'medium' : 'low',
            distanceFromStartKm: cumulativeDistance,
            providers: ['Airtel', 'Jio', 'Vi'], // Placeholder
            createdAt: new Date()
        };
        
        networkData.push(coverage);
    }
    
    // Save to MongoDB
    if (networkData.length > 0) {
        await db.collection(COLLECTIONS.NETWORK_COVERAGES).insertMany(networkData);
        log('info', `Saved ${networkData.length} network coverage points for route ${routeId}`);
    }
    
    return networkData;
}

// Identify blind spots (simplified analysis)
async function identifyAndSaveBlindSpots(routeId, coordinates) {
    const blindSpots = [];
    let cumulativeDistance = 0;
    
    for (let i = 2; i < coordinates.length - 2; i++) {
        const p1 = coordinates[i - 2];
        const p2 = coordinates[i - 1];
        const p3 = coordinates[i];
        const p4 = coordinates[i + 1];
        const p5 = coordinates[i + 2];
        
        cumulativeDistance += calculateDistance(p2.lat, p2.lng, p3.lat, p3.lng);
        
        // Calculate elevation changes (would need actual elevation data)
        // Simulating crest detection
        const bearing1 = calculateBearing(p1.lat, p1.lng, p3.lat, p3.lng);
        const bearing2 = calculateBearing(p3.lat, p3.lng, p5.lat, p5.lng);
        const bearingChange = Math.abs(bearing2 - bearing1);
        
        // Detect potential blind spots
        if (bearingChange > 30 && Math.random() > 0.7) { // Simplified detection
            const spotType = bearingChange > 60 ? 'sharp_curve' : 'curve';
            const riskScore = bearingChange > 60 ? 8 : 6;
            
            const blindSpot = {
                routeId: new ObjectId(routeId),
                location: {
                    type: "Point",
                    coordinates: [p3.lng, p3.lat]
                },
                latitude: p3.lat,
                longitude: p3.lng,
                spotType: spotType,
                visibilityDistance: bearingChange > 60 ? 50 : 100, // meters
                obstructionHeight: 0, // Would need terrain data
                roadWidth: 7, // Default estimate
                riskScore: riskScore,
                mirrorInstalled: false,
                warningSignsPresent: false,
                driverActionRequired: 'Reduce speed and honk before curve',
                distanceFromStartKm: cumulativeDistance,
                createdAt: new Date()
            };
            
            blindSpots.push(blindSpot);
        }
    }
    
    // Save to MongoDB
    if (blindSpots.length > 0) {
        await db.collection(COLLECTIONS.BLIND_SPOTS).insertMany(blindSpots);
        log('info', `Saved ${blindSpots.length} blind spots for route ${routeId}`);
    }
    
    return blindSpots;
}

// Identify accident prone areas (based on sharp turns and road conditions)
async function identifyAndSaveAccidentProneAreas(routeId, sharpTurns, roadConditions) {
    const accidentProneAreas = [];
    
    // Mark sharp turns as accident prone
    for (const turn of sharpTurns) {
        if (turn.riskScore >= 7) {
            const area = {
                routeId: new ObjectId(routeId),
                location: turn.location,
                latitude: turn.latitude,
                longitude: turn.longitude,
                riskScore: turn.riskScore,
                accidentFrequency: 'high', // Would need historical data
                accidentType: 'vehicle_rollover',
                severityLevel: turn.riskScore >= 9 ? 'critical' : 'high',
                contributingFactors: ['sharp_turn', `${turn.turnAngle.toFixed(0)}° turn`],
                distanceFromStartKm: turn.distanceFromStartKm,
                createdAt: new Date()
            };
            
            accidentProneAreas.push(area);
        }
    }
    
    // Mark poor road conditions as accident prone
    for (const condition of roadConditions) {
        if (condition.riskScore >= 7) {
            const area = {
                routeId: new ObjectId(routeId),
                location: condition.location,
                latitude: condition.latitude,
                longitude: condition.longitude,
                riskScore: condition.riskScore,
                accidentFrequency: 'medium',
                accidentType: 'skidding',
                severityLevel: condition.riskScore >= 8 ? 'high' : 'medium',
                contributingFactors: [condition.surfaceQuality + '_road_surface', condition.roadType],
                distanceFromStartKm: 0, // Would need to calculate
                createdAt: new Date()
            };
            
            accidentProneAreas.push(area);
        }
    }
    
    // Save to MongoDB
    if (accidentProneAreas.length > 0) {
        await db.collection(COLLECTIONS.ACCIDENT_PRONE_AREAS).insertMany(accidentProneAreas);
        log('info', `Saved ${accidentProneAreas.length} accident prone areas for route ${routeId}`);
    }
    
    return accidentProneAreas;
}

// Check for eco-sensitive zones
async function checkAndSaveEcoSensitiveZones(routeId, coordinates) {
    try {
        const ecoZones = [];
        const lats = coordinates.map(c => c.lat);
        const lngs = coordinates.map(c => c.lng);
        const minLat = Math.min(...lats) - 0.02;
        const maxLat = Math.max(...lats) + 0.02;
        const minLng = Math.min(...lngs) - 0.02;
        const maxLng = Math.max(...lngs) + 0.02;
        
        // Query for protected areas, forests, etc.
        const query = `[out:json][timeout:30];
(
  way["boundary"="protected_area"](${minLat},${minLng},${maxLat},${maxLng});
  way["boundary"="national_park"](${minLat},${minLng},${maxLat},${maxLng});
  way["natural"="wood"](${minLat},${minLng},${maxLat},${maxLng});
  way["landuse"="forest"](${minLat},${minLng},${maxLat},${maxLng});
  way["leisure"="nature_reserve"](${minLat},${minLng},${maxLat},${maxLng});
);
out center;`;
        
        const data = await queryOverpass(query);
        
        if (data.elements && data.elements.length > 0) {
            for (const element of data.elements) {
                const lat = element.center?.lat;
                const lng = element.center?.lon;
                
                if (!lat || !lng) continue;
                
                const zoneType = element.tags.boundary || element.tags.natural || element.tags.landuse || 'protected_area';
                const name = element.tags.name || `${zoneType.replace('_', ' ')} zone`;
                
                const ecoZone = {
                    routeId: new ObjectId(routeId),
                    location: {
                        type: "Point",
                        coordinates: [lng, lat]
                    },
                    latitude: lat,
                    longitude: lng,
                    riskType: 'eco-sensitive',
                    zoneType: zoneType,
                    name: name,
                    severity: zoneType === 'national_park' ? 'critical' : 'high',
                    complianceRequired: 'No horn, maintain speed limits, no littering',
                    restrictions: ['no_horn', 'speed_limit_40', 'no_stopping'],
                    createdAt: new Date()
                };
                
                ecoZones.push(ecoZone);
            }
        }
        
        // Save to MongoDB
        if (ecoZones.length > 0) {
            await db.collection(COLLECTIONS.ECO_SENSITIVE_ZONES).insertMany(ecoZones);
            log('info', `Saved ${ecoZones.length} eco-sensitive zones for route ${routeId}`);
        }
        
        return ecoZones;
    } catch (error) {
        log('error', 'Error checking eco-sensitive zones', { error: error.message });
        return [];
    }
}

// Save complete route information
async function saveCompleteRoute(routeInfo, coordinates) {
    try {
        const startCoord = coordinates[0];
        const endCoord = coordinates[coordinates.length - 1];
        const totalDistance = calculateTotalDistance(coordinates);
        
        // Get addresses for start and end points
        const [fromAddress, toAddress] = await Promise.all([
            reverseGeocode(startCoord.lat, startCoord.lng),
            reverseGeocode(endCoord.lat, endCoord.lng)
        ]);
        
        // Extract major highways from route
        const majorHighways = [];
        const routePoints = coordinates.map(c => ({
            lat: c.lat,
            lng: c.lng,
            stepId: c.stepId
        }));
        
        const route = {
            routeName: `${routeInfo.depotCode}_to_${routeInfo.consumerCode}`,
            fromCode: routeInfo.depotCode,
            toCode: routeInfo.consumerCode,
            fromAddress: fromAddress,
            toAddress: toAddress,
            fromCoordinates: {
                type: "Point",
                coordinates: [startCoord.lng, startCoord.lat]
            },
            toCoordinates: {
                type: "Point",
                coordinates: [endCoord.lng, endCoord.lat]
            },
            totalDistance: totalDistance,
            estimatedDuration: (totalDistance / 40) * 60, // Assuming 40 km/h average
            majorHighways: majorHighways,
            terrain: 'mixed', // Would need elevation data
            routePoints: routePoints,
            totalWaypoints: coordinates.length,
            customerName: routeInfo.customerName || '',
            location: routeInfo.location || '',
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        // Insert route and get the ID
        const result = await db.collection(COLLECTIONS.ROUTES).insertOne(route);
        const routeId = result.insertedId;
        
        log('info', chalk.green(`✓ Saved route ${route.routeName} with ID: ${routeId}`));
        
        return routeId;
    } catch (error) {
        log('error', 'Error saving route', { error: error.message });
        throw error;
    }
}

// API Endpoints

// Middleware to check API permissions
async function checkAPIPermission(req, res, next) {
    const apiName = req.query.apiName || req.body.apiName;
    const userId = req.headers['x-user-id'] || 'guest';
    
    const restrictedAPIs = ['weather', 'traffic', 'geocoding'];
    
    if (restrictedAPIs.includes(apiName)) {
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
            log('error', chalk.red('✗ No CSV files found!'));
            processProgress.status = 'error';
            processProgress.errors.push('No CSV files found');
            return res.json([]);
        }
        
        const routes = [];
        let totalCsvRoutes = 0;
        
        // Process routes from CSV
        for (const csvFile of csvFiles) {
            const csvPath = path.join(routeDataPath, csvFile);
            const csvData = await parseRouteCSV(csvPath);
            
            totalCsvRoutes += csvData.length;
            processProgress.totalRoutes = totalCsvRoutes;
            
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
                        break;
                    }
                }
                
                if (foundFile && coordinates.length > 0) {
                    // Save complete route data to MongoDB
                    const routeInfo = {
                        depotCode: buCode,
                        consumerCode: rowLabel,
                        customerName: customerName,
                        location: location,
                        filename: foundFile
                    };
                    
                    const routeId = await saveCompleteRoute(routeInfo, coordinates);
                    
                    // Analyze and save all route data
                    log('info', `Analyzing route ${routeInfo.depotCode} → ${routeInfo.consumerCode}...`);
                    
                    // Run all analyses in parallel
                    await Promise.all([
                        analyzeAndSaveSharpTurns(routeId, coordinates),
                        getAndSaveEmergencyServices(routeId, coordinates),
                        analyzeAndSaveRoadConditions(routeId, coordinates),
                        analyzeAndSaveNetworkCoverage(routeId, coordinates),
                        identifyAndSaveBlindSpots(routeId, coordinates),
                        checkAndSaveEcoSensitiveZones(routeId, coordinates)
                    ]);
                    
                    processProgress.statistics.totalWithCoordinates++;
                    processProgress.statistics.totalWaypoints += coordinates.length;
                    processProgress.statistics.totalDistance += parseFloat(calculateTotalDistance(coordinates));
                    
                    routes.push({
                        id: routeId.toString(),
                        routeId: routeId.toString(),
                        depotCode: buCode,
                        consumerCode: rowLabel,
                        customerName: customerName,
                        location: location,
                        filename: foundFile,
                        totalSteps: coordinates.length,
                        hasCoordinates: true,
                        totalDistance: calculateTotalDistance(coordinates)
                    });
                } else {
                    processProgress.statistics.totalWithoutCoordinates++;
                    routes.push({
                        id: `pending_${buCode}_${rowLabel}`,
                        depotCode: buCode,
                        consumerCode: rowLabel,
                        customerName: customerName,
                        location: location,
                        filename: 'No file found',
                        totalSteps: 0,
                        hasCoordinates: false,
                        expectedFilenames: possibleFilenames
                    });
                }
            }
        }
        
        processProgress.endTime = new Date();
        processProgress.statistics.processingTime = (processProgress.endTime - processProgress.startTime) / 1000;
        processProgress.statistics.averageWaypoints = processProgress.statistics.totalWithCoordinates > 0 
            ? Math.round(processProgress.statistics.totalWaypoints / processProgress.statistics.totalWithCoordinates) 
            : 0;
        
        processProgress.status = 'complete';
        
        log('info', chalk.cyan('\n=== Processing Complete ==='));
        log('info', chalk.green(`✓ Routes processed: ${routes.length}`));
        log('info', chalk.green(`✓ Data saved to MongoDB collections`));
        
        res.json(routes);
    } catch (error) {
        log('error', 'Error getting routes', { error: error.message });
        processProgress.status = 'error';
        processProgress.errors.push(error.message);
        res.status(500).json({ error: 'Failed to fetch routes' });
    }
});

// Get detailed route analysis
app.get('/api/routes/:routeId/analysis', checkAPIPermission, async (req, res) => {
    try {
        const { routeId } = req.params;
        const enhancedAnalysis = req.query.enhanced === 'true';
        
        // Get route details from MongoDB
        const route = await db.collection(COLLECTIONS.ROUTES).findOne({ 
            _id: new ObjectId(routeId) 
        });
        
        if (!route) {
            return res.status(404).json({ error: 'Route not found' });
        }
        
        // Get all related data from MongoDB
        const [
            sharpTurns,
            blindSpots,
            accidentProneAreas,
            roadConditions,
            emergencyServices,
            networkCoverages,
            ecoSensitiveZones
        ] = await Promise.all([
            db.collection(COLLECTIONS.SHARP_TURNS).find({ routeId: new ObjectId(routeId) }).toArray(),
            db.collection(COLLECTIONS.BLIND_SPOTS).find({ routeId: new ObjectId(routeId) }).toArray(),
            db.collection(COLLECTIONS.ACCIDENT_PRONE_AREAS).find({ routeId: new ObjectId(routeId) }).toArray(),
            db.collection(COLLECTIONS.ROAD_CONDITIONS).find({ routeId: new ObjectId(routeId) }).toArray(),
            db.collection(COLLECTIONS.EMERGENCY_SERVICES).find({ routeId: new ObjectId(routeId) }).toArray(),
            db.collection(COLLECTIONS.NETWORK_COVERAGES).find({ routeId: new ObjectId(routeId) }).toArray(),
            db.collection(COLLECTIONS.ECO_SENSITIVE_ZONES).find({ routeId: new ObjectId(routeId) }).toArray()
        ]);
        
        const analysisData = {
            route: route,
            sharpTurns: sharpTurns,
            blindSpots: blindSpots,
            accidentProneAreas: accidentProneAreas,
            roadConditions: roadConditions,
            emergencyServices: emergencyServices,
            networkCoverages: networkCoverages,
            ecoSensitiveZones: ecoSensitiveZones
        };
        
        // Get traffic and weather data if enhanced analysis requested and permission granted
        if (enhancedAnalysis && req.headers['x-api-permission'] === 'confirmed') {
            const [trafficData, weatherConditions] = await Promise.all([
                getAndSaveTrafficData(routeId, route.routePoints),
                getAndSaveWeatherData(routeId, route.routePoints)
            ]);
            
            // Also get any existing data from MongoDB
            const [existingTraffic, existingWeather] = await Promise.all([
                db.collection(COLLECTIONS.TRAFFIC_DATA).find({ routeId: new ObjectId(routeId) }).toArray(),
                db.collection(COLLECTIONS.WEATHER_CONDITIONS).find({ routeId: new ObjectId(routeId) }).toArray()
            ]);
            
            analysisData.trafficData = existingTraffic.length > 0 ? existingTraffic : trafficData;
            analysisData.weatherConditions = existingWeather.length > 0 ? existingWeather : weatherConditions;
        }
        
        res.json(analysisData);
    } catch (error) {
        log('error', 'Error getting route analysis', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch route analysis' });
    }
});

// Get specific collection data
app.get('/api/data/:collection', async (req, res) => {
    try {
        const { collection } = req.params;
        const { routeId, limit = 1000 } = req.query;
        
        // Validate collection name
        if (!Object.values(COLLECTIONS).includes(collection)) {
            return res.status(400).json({ error: 'Invalid collection name' });
        }
        
        const query = routeId ? { routeId: new ObjectId(routeId) } : {};
        const data = await db.collection(collection)
            .find(query)
            .limit(parseInt(limit))
            .toArray();
        
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mongodb: client ? 'connected' : 'disconnected',
        collections: Object.values(COLLECTIONS),
        config: {
            overpassUrl: OVERPASS_API_URL,
            weatherEnabled: !!OPENWEATHER_API_KEY,
            trafficEnabled: !!TOMTOM_API_KEY,
            geocodingEnabled: !!MAPBOX_API_KEY
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
    log('info', chalk.cyan('   Route Management System v3.0  '));
    log('info', chalk.cyan('================================='));
    log('info', chalk.green(`✓ Server running on http://localhost:${PORT}`));
    log('info', chalk.green(`✓ MongoDB URI: ${MONGODB_URI}`));
    log('info', chalk.green(`✓ Default admin: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`));
    log('info', chalk.green(`✓ Using Overpass API at: ${OVERPASS_API_URL}`));
    log('info', chalk.cyan('=================================\n'));
    
    await ensureRouteDataDirectory();
    await connectToMongoDB();
});