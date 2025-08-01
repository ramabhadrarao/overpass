// MongoDB Models for Enhanced Route Management System
// Save this as models/routeModels.js

const { MongoClient, ObjectId } = require('mongodb');

// MongoDB connection
let db;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/route_management';

async function connectDB() {
    try {
        const client = await MongoClient.connect(MONGODB_URI, {
            useUnifiedTopology: true
        });
        db = client.db();
        console.log('Connected to MongoDB');
        
        // Create indexes
        await createIndexes();
        
        return db;
    } catch (error) {
        console.error('MongoDB connection error:', error);
        throw error;
    }
}

// Create indexes for better query performance
async function createIndexes() {
    // Routes collection indexes
    await db.collection('routes').createIndexes([
        { key: { routeId: 1 }, unique: true },
        { key: { depotCode: 1 } },
        { key: { consumerCode: 1 } },
        { key: { createdAt: -1 } },
        { key: { 'startLocation.coordinates': '2dsphere' } },
        { key: { 'endLocation.coordinates': '2dsphere' } }
    ]);
    
    // Accident prone areas indexes
    await db.collection('accident_prone_areas').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { severity: 1 } }
    ]);
    
    // Blind spots indexes
    await db.collection('blind_spots').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { visibility: 1 } }
    ]);
    
    // Eco sensitive zones indexes
    await db.collection('eco_sensitive_zones').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { type: 1 } }
    ]);
    
    // Emergency services indexes
    await db.collection('emergency_services').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { type: 1 } }
    ]);
    
    // Network coverage indexes
    await db.collection('network_coverages').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { coverage: 1 } }
    ]);
    
    // Road conditions indexes
    await db.collection('road_conditions').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { road_type: 1 } },
        { key: { condition: 1 } }
    ]);
    
    // Sharp turns indexes
    await db.collection('sharp_turns').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { angle: -1 } }
    ]);
    
    // Traffic data indexes
    await db.collection('traffic_data').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { timestamp: -1 } },
        { key: { congestion_level: 1 } }
    ]);
    
    // Weather conditions indexes
    await db.collection('weather_conditions').createIndexes([
        { key: { routeId: 1 } },
        { key: { location: '2dsphere' } },
        { key: { timestamp: -1 } }
    ]);
}

// Schema definitions
const schemas = {
    // Main route schema
    route: {
        _id: ObjectId,
        routeId: String, // Unique identifier (filename)
        depotCode: String,
        consumerCode: String,
        customerName: String,
        location: String,
        filename: String,
        totalWaypoints: Number,
        totalDistance: Number,
        startLocation: {
            type: 'Point',
            coordinates: [Number, Number], // [lng, lat]
            address: String,
            isPetrolPump: Boolean
        },
        endLocation: {
            type: 'Point',
            coordinates: [Number, Number], // [lng, lat]
            address: String,
            isPetrolPump: Boolean
        },
        waypoints: [{
            stepId: String,
            type: 'Point',
            coordinates: [Number, Number], // [lng, lat]
            routeType: String,
            additionalData: Object
        }],
        bounds: {
            north: Number,
            south: Number,
            east: Number,
            west: Number
        },
        createdAt: Date,
        updatedAt: Date,
        lastAnalyzed: Date
    },
    
    // Accident prone areas schema
    accidentProneArea: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        type: String,
        description: String,
        severity: String, // 'high', 'medium', 'low'
        address: String,
        mapLink: String,
        reportedIncidents: Number,
        lastIncidentDate: Date,
        createdAt: Date
    },
    
    // Blind spots schema
    blindSpot: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        type: String, // 'curve_obstruction', 'intersection', 'elevation_change'
        visibility: String, // 'poor', 'limited', 'moderate'
        obstructions: Number,
        angle: Number,
        address: String,
        mapLink: String,
        createdAt: Date
    },
    
    // Eco sensitive zones schema
    ecoSensitiveZone: {
        _id: ObjectId,
        routeId: String,
        name: String,
        type: String, // 'nature_reserve', 'protected_area', 'forest', 'wetland'
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        protectionLevel: String,
        restrictions: String,
        area: Number, // in square kilometers
        mapLink: String,
        createdAt: Date
    },
    
    // Emergency services schema
    emergencyService: {
        _id: ObjectId,
        routeId: String,
        name: String,
        type: String, // 'hospital', 'police', 'fire_station', 'pharmacy'
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        phone: String,
        emergencyPhone: String,
        address: String,
        openingHours: String,
        website: String,
        mapLink: String,
        distanceFromRoute: Number, // in kilometers
        createdAt: Date
    },
    
    // Network coverage schema
    networkCoverage: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        coverage: String, // 'excellent', 'good', 'fair', 'poor'
        signalStrength: String,
        towersNearby: Number,
        providers: [String],
        address: String,
        mapLink: String,
        measuredAt: Date,
        createdAt: Date
    },
    
    // Road conditions schema
    roadCondition: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        roadType: String, // 'highway', 'trunk', 'primary', 'secondary', etc.
        surface: String, // 'asphalt', 'concrete', 'gravel', 'dirt'
        condition: String, // 'excellent', 'good', 'intermediate', 'bad', 'very_bad'
        width: String,
        lanes: String,
        maxSpeed: String,
        lighting: Boolean,
        construction: String,
        address: String,
        mapLink: String,
        lastUpdated: Date,
        createdAt: Date
    },
    
    // Sharp turns schema
    sharpTurn: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        angle: Number, // in degrees
        severity: String, // calculated based on angle
        waypointIndex: Number,
        address: String,
        mapLink: String,
        warningSignPresent: Boolean,
        createdAt: Date
    },
    
    // Traffic data schema
    trafficData: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        currentSpeed: Number,
        freeFlowSpeed: Number,
        congestionLevel: String, // 'free_flow', 'light', 'moderate', 'heavy', 'severe'
        confidence: Number,
        roadClosure: Boolean,
        address: String,
        mapLink: String,
        timestamp: Date,
        createdAt: Date
    },
    
    // Weather conditions schema
    weatherCondition: {
        _id: ObjectId,
        routeId: String,
        location: {
            type: 'Point',
            coordinates: [Number, Number] // [lng, lat]
        },
        temperature: Number,
        description: String,
        humidity: Number,
        windSpeed: Number,
        visibility: Number,
        precipitation: Number,
        address: String,
        mapLink: String,
        timestamp: Date,
        createdAt: Date
    },
    
    // User schema for authentication
    user: {
        _id: ObjectId,
        username: String,
        email: String,
        password: String, // hashed
        role: String, // 'admin', 'operator', 'viewer'
        permissions: [String],
        lastLogin: Date,
        createdAt: Date,
        updatedAt: Date
    }
};

// Model functions
const models = {
    // Save route analysis data
    async saveRouteAnalysis(routeData, analysisData) {
        const session = db.client.startSession();
        
        try {
            await session.withTransaction(async () => {
                // Save main route
                const route = {
                    routeId: routeData.routeId,
                    depotCode: routeData.routeInfo.depotCode,
                    consumerCode: routeData.routeInfo.consumerCode,
                    customerName: routeData.customerName || 'Unknown',
                    location: routeData.location || 'Unknown',
                    filename: routeData.routeInfo.filename,
                    totalWaypoints: routeData.coordinates.length,
                    totalDistance: parseFloat(routeData.totalDistance),
                    startLocation: {
                        type: 'Point',
                        coordinates: [routeData.startLocation.lng, routeData.startLocation.lat],
                        address: routeData.startLocation.address || '',
                        isPetrolPump: routeData.startLocation.isPetrolPump
                    },
                    endLocation: {
                        type: 'Point',
                        coordinates: [routeData.endLocation.lng, routeData.endLocation.lat],
                        address: routeData.endLocation.address || '',
                        isPetrolPump: routeData.endLocation.isPetrolPump
                    },
                    waypoints: routeData.coordinates.map(coord => ({
                        stepId: coord.stepId,
                        type: 'Point',
                        coordinates: [coord.lng, coord.lat],
                        routeType: coord.Route_Type || coord.route_type || '',
                        additionalData: coord
                    })),
                    bounds: routeData.bounds,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    lastAnalyzed: new Date()
                };
                
                await db.collection('routes').replaceOne(
                    { routeId: routeData.routeId },
                    route,
                    { upsert: true, session }
                );
                
                // Save accident prone areas
                if (analysisData.accident_prone_areas?.length > 0) {
                    await db.collection('accident_prone_areas').deleteMany({ routeId: routeData.routeId }, { session });
                    await db.collection('accident_prone_areas').insertMany(
                        analysisData.accident_prone_areas.map(area => ({
                            ...area,
                            routeId: routeData.routeId,
                            location: {
                                type: 'Point',
                                coordinates: [area.lng, area.lat]
                            },
                            createdAt: new Date()
                        })),
                        { session }
                    );
                }
                
                // Save blind spots
                if (analysisData.blind_spots?.length > 0) {
                    await db.collection('blind_spots').deleteMany({ routeId: routeData.routeId }, { session });
                    await db.collection('blind_spots').insertMany(
                        analysisData.blind_spots.map(spot => ({
                            ...spot,
                            routeId: routeData.routeId,
                            location: {
                                type: 'Point',
                                coordinates: [spot.lng, spot.lat]
                            },
                            createdAt: new Date()
                        })),
                        { session }
                    );
                }
                
                // Save other collections similarly...
                // (eco_sensitive_zones, emergency_services, network_coverages, etc.)
            });
            
            console.log(`✓ Saved route analysis for ${routeData.routeId}`);
        } catch (error) {
            console.error('Error saving route analysis:', error);
            throw error;
        } finally {
            await session.endSession();
        }
    },
    
    // Get route with all analysis data
    async getRouteWithAnalysis(routeId) {
        const route = await db.collection('routes').findOne({ routeId });
        if (!route) return null;
        
        const [
            accidentProneAreas,
            blindSpots,
            ecoSensitiveZones,
            emergencyServices,
            networkCoverages,
            roadConditions,
            sharpTurns,
            trafficData,
            weatherConditions
        ] = await Promise.all([
            db.collection('accident_prone_areas').find({ routeId }).toArray(),
            db.collection('blind_spots').find({ routeId }).toArray(),
            db.collection('eco_sensitive_zones').find({ routeId }).toArray(),
            db.collection('emergency_services').find({ routeId }).toArray(),
            db.collection('network_coverages').find({ routeId }).toArray(),
            db.collection('road_conditions').find({ routeId }).toArray(),
            db.collection('sharp_turns').find({ routeId }).toArray(),
            db.collection('traffic_data').find({ routeId }).sort({ timestamp: -1 }).limit(50).toArray(),
            db.collection('weather_conditions').find({ routeId }).sort({ timestamp: -1 }).limit(20).toArray()
        ]);
        
        return {
            route,
            analysisData: {
                accident_prone_areas: accidentProneAreas,
                blind_spots: blindSpots,
                eco_sensitive_zones: ecoSensitiveZones,
                emergency_services: emergencyServices,
                network_coverages: networkCoverages,
                road_conditions: roadConditions,
                sharp_turns: sharpTurns,
                traffic_data: trafficData,
                weather_conditions: weatherConditions
            }
        };
    },
    
    // Find nearby points of interest
    async findNearbyPOIs(lat, lng, type, maxDistance = 5000) {
        const point = {
            type: 'Point',
            coordinates: [lng, lat]
        };
        
        const collections = {
            emergency: 'emergency_services',
            accident: 'accident_prone_areas',
            eco: 'eco_sensitive_zones',
            blind: 'blind_spots'
        };
        
        const collection = collections[type] || 'emergency_services';
        
        return await db.collection(collection).find({
            location: {
                $near: {
                    $geometry: point,
                    $maxDistance: maxDistance
                }
            }
        }).limit(10).toArray();
    },
    
    // Get routes by criteria
    async getRoutesByCriteria(criteria) {
        const query = {};
        
        if (criteria.depotCode) query.depotCode = criteria.depotCode;
        if (criteria.consumerCode) query.consumerCode = criteria.consumerCode;
        if (criteria.customerName) query.customerName = new RegExp(criteria.customerName, 'i');
        
        return await db.collection('routes').find(query).toArray();
    },
    
    // Update traffic data (real-time)
    async updateTrafficData(routeId, trafficPoints) {
        const bulkOps = trafficPoints.map(point => ({
            updateOne: {
                filter: {
                    routeId,
                    'location.coordinates': [point.lng, point.lat]
                },
                update: {
                    $set: {
                        ...point,
                        location: {
                            type: 'Point',
                            coordinates: [point.lng, point.lat]
                        },
                        timestamp: new Date(),
                        updatedAt: new Date()
                    }
                },
                upsert: true
            }
        }));
        
        return await db.collection('traffic_data').bulkWrite(bulkOps);
    },
    
    // Get aggregated statistics
    async getRouteStatistics() {
        const stats = await db.collection('routes').aggregate([
            {
                $group: {
                    _id: null,
                    totalRoutes: { $sum: 1 },
                    totalDistance: { $sum: '$totalDistance' },
                    totalWaypoints: { $sum: '$totalWaypoints' },
                    avgDistance: { $avg: '$totalDistance' },
                    avgWaypoints: { $avg: '$totalWaypoints' }
                }
            }
        ]).toArray();
        
        const hazardStats = await Promise.all([
            db.collection('accident_prone_areas').countDocuments(),
            db.collection('blind_spots').countDocuments(),
            db.collection('sharp_turns').countDocuments(),
            db.collection('emergency_services').countDocuments()
        ]);
        
        return {
            routes: stats[0] || {},
            hazards: {
                accidentProneAreas: hazardStats[0],
                blindSpots: hazardStats[1],
                sharpTurns: hazardStats[2],
                emergencyServices: hazardStats[3]
            }
        };
    }
};

module.exports = {
    connectDB,
    db: () => db,
    schemas,
    models
};