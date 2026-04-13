'use strict';

let carStatusLastUpdated = new Date().toISOString();
let prevCarStatus = null;

module.exports = function mountCarsRoutes(app, db, deps) {
  const { socketState, CARS, RATE_PER_MINUTE, apiReadLimiter } = deps;

  function getCarAvailabilityStatus() {
    let status;
    if (process.env.CAR_OFFLINE === 'true') {
      status = 'offline';
    } else if (socketState.activeSessions.size > 0) {
      status = 'busy';
    } else {
      status = 'available';
    }
    if (status !== prevCarStatus) {
      carStatusLastUpdated = new Date().toISOString();
      prevCarStatus = status;
    }
    return { status, lastUpdated: carStatusLastUpdated };
  }

  app.get('/api/cars', apiReadLimiter, (req, res) => {
    const activeCars = new Set([...socketState.activeSessions.values()].map((s) => s.carId));
    const maintRows = db.prepare('SELECT car_id FROM car_maintenance WHERE enabled = 1').all();
    const maintenanceCars = new Set(maintRows.map((r) => r.car_id));
    res.json({
      ratePerMinute: RATE_PER_MINUTE,
      cars: CARS.map((c) => {
        let status;
        if (maintenanceCars.has(c.id)) {
          status = 'maintenance';
        } else if (activeCars.has(c.id)) {
          status = 'unavailable';
        } else {
          status = 'available';
        }
        return { ...c, status };
      }),
    });
  });

  app.get('/api/car-status', (req, res) => {
    res.json(getCarAvailabilityStatus());
  });

  app.get('/api/races', (req, res) => {
    const races = [...socketState.raceRooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      playerCount: r.players.length,
      status: r.status,
      createdAt: r.createdAt,
    }));
    res.json({ races });
  });
};
