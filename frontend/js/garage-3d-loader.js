// Per-variant car model map: variant id → .glb file path
export const CAR_MODEL_MAP = {
    1: '/assets/3d/cars/model01.glb',
    2: '/assets/3d/cars/model02.glb',
    3: '/assets/3d/cars/model03.glb',
    4: '/assets/3d/cars/model04.glb',
    5: '/assets/3d/cars/model05.glb',
};

// Shared garage environment model path
export const GARAGE_MODEL_PATH = '/assets/3d/garage/garage01.glb';

// Cached manifest promise (fetched once per page load)
let _manifestPromise = null;

async function getManifest() {
    if (!_manifestPromise) {
        _manifestPromise = fetch('/assets/3d/manifest.json')
            .then(r => r.ok ? r.json() : { models: [] })
            .catch(() => ({ models: [] }));
    }
    return _manifestPromise;
}

// Detect best quality level based on hardware
export function detectQuality() {
    const cores = navigator.hardwareConcurrency || 2;
    const saved = localStorage.getItem('garageQuality');
    if (saved === 'low' || saved === 'high') return saved;
    // Mobile or low-end: use low
    const isMobile = /Mobi|Android/i.test(navigator.userAgent);
    if (isMobile || cores <= 2) return 'low';
    return 'high';
}

// Save user quality preference
export function setQuality(level) {
    localStorage.setItem('garageQuality', level);
}

// Load a .glb model with progress callback
// Returns the loaded THREE.Group (gltf.scene) or null if file doesn't exist / fails
// onProgress receives { loaded, total } (bytes)
export async function loadModel(url, onProgress) {
    const { GLTFLoader } = await import('/vendor/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();

    return new Promise((resolve, reject) => {
        loader.load(
            url,
            (gltf) => resolve(gltf.scene),
            (xhr) => {
                if (onProgress && xhr.total > 0) {
                    onProgress({ loaded: xhr.loaded, total: xhr.total });
                }
            },
            (error) => reject(error)
        );
    });
}

// Try to load a car model by variant id; returns null gracefully if not available
export async function loadCarModel(variantId, onProgress) {
    const path = CAR_MODEL_MAP[variantId];
    if (!path) return null;
    try {
        const manifest = await getManifest();
        if (!manifest.models || !manifest.models.includes(path)) return null;
        return await loadModel(path, onProgress);
    } catch (e) {
        console.warn('[garage-3d-loader] Car model not available, using procedural fallback:', e.message);
        return null;
    }
}

// Try to load the shared garage environment model; returns null gracefully if not available
export async function loadGarageModel(onProgress) {
    try {
        const manifest = await getManifest();
        if (!manifest.models || !manifest.models.includes(GARAGE_MODEL_PATH)) return null;
        return await loadModel(GARAGE_MODEL_PATH, onProgress);
    } catch (e) {
        console.warn('[garage-3d-loader] Garage model not available, using procedural environment:', e.message);
        return null;
    }
}
