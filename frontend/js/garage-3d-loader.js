// Quality presets — paths to .glb files (files don't need to exist yet)
export const QUALITY_PRESETS = {
    low: {
        car: '/assets/3d/cars/riley-x1-low.glb',
        garage: null,
    },
    high: {
        car: '/assets/3d/cars/riley-x1.glb',
        garage: '/assets/3d/garage/garage.glb',
    },
};

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

// Try to load a car model; returns null gracefully if not available
export async function loadCarModel(quality, onProgress) {
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.low;
    if (!preset.car) return null;
    try {
        const manifest = await getManifest();
        if (!manifest.models || !manifest.models.includes(preset.car)) return null;
        return await loadModel(preset.car, onProgress);
    } catch (e) {
        console.warn('[garage-3d-loader] Car model not available, using procedural fallback:', e.message);
        return null;
    }
}
