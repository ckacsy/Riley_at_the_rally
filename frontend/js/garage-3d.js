// three.js and OrbitControls are loaded lazily via dynamic import() inside
// initScene() so the 700 KB bundle is never fetched when WebGL is unavailable.
let THREE;
let OrbitControls;

// Car color variants (class/type used for carousel filters)
const CAR_VARIANTS = [
    { id: 1, name: 'Алый',    bodyHex: '#e53935', trimHex: '#ffffff', body: 0xe53935, trim: 0xffffff, cls: 'sport', type: 'drift' },
    { id: 2, name: 'Синий',   bodyHex: '#1e88e5', trimHex: '#ffffff', body: 0x1e88e5, trim: 0xffffff, cls: 'sport', type: 'drift' },
    { id: 3, name: 'Зелёный', bodyHex: '#43a047', trimHex: '#ffffff', body: 0x43a047, trim: 0xffffff, cls: 'sport', type: 'drift' },
    { id: 4, name: 'Золотой', bodyHex: '#fdd835', trimHex: '#212121', body: 0xfdd835, trim: 0x212121, cls: 'sport', type: 'drift' },
    { id: 5, name: 'Чёрный',  bodyHex: '#1c1c1c', trimHex: '#e53935', body: 0x1c1c1c, trim: 0xe53935, cls: 'sport', type: 'drift' },
];

let activeVariant = 0;
let carGroup = null;
let scene, camera, renderer, controls;
let autoRotate = true;
let fpsCounter = 0, lastFpsTime = performance.now(), currentFps = 0;

window._garageScene = {
    setAutoRotate: (v) => { autoRotate = v; },
    getFps:        ()  => currentFps,
};
window.CAR_VARIANTS_REF = CAR_VARIANTS;
window._activeVariant = 0;

if (window.__garageNeedsWebGLFallback) {
    renderCarousel();
    const v0 = CAR_VARIANTS[0];
    document.getElementById('car-title').textContent = 'Riley-X1 \u00b7 ' + v0.name;
} else {
    initScene().catch((err) => {
        console.error('[garage-3d] 3D scene initialization failed:', err);
        window.__showGarageFallback('init_failed');
        renderCarousel();
        const v0 = CAR_VARIANTS[0];
        const titleEl = document.getElementById('car-title');
        if (titleEl) titleEl.textContent = 'Riley-X1 \u00b7 ' + v0.name;
    });
}

async function initScene() {
    [THREE, { OrbitControls }] = await Promise.all([
        import('/vendor/three.module.min.js'),
        import('/vendor/controls/OrbitControls.js'),
    ]);

    const canvas = document.getElementById('garage-canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1525);
    scene.fog = new THREE.FogExp2(0x0d1525, 0.005);

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
    camera.position.set(0, 2.8, 7);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 3;
    controls.maxDistance = 50;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.target.set(0, 0.5, 0);
    controls.update();

    addLighting();
    addEnvironment();
    carGroup = buildCar(CAR_VARIANTS[0].body, CAR_VARIANTS[0].trim);
    scene.add(carGroup);

    renderCarousel();
    window.addEventListener('resize', onResize);
    animate();
    setTimeout(() => { document.getElementById('scene-loading').classList.add('hidden'); }, 300);
}

function addLighting() {
    scene.add(new THREE.AmbientLight(0x6688aa, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 9, 5); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 30;
    key.shadow.camera.left = key.shadow.camera.bottom = -8;
    key.shadow.camera.right = key.shadow.camera.top = 8;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x4466bb, 0.45);
    fill.position.set(-4, 4, -3); scene.add(fill);
    const rim = new THREE.DirectionalLight(0xaaccff, 0.3);
    rim.position.set(0, 3, -7); scene.add(rim);
    [-4, 0, 4].forEach(x => {
        const spot = new THREE.SpotLight(0xffeedd, 0.7, 22, Math.PI / 7, 0.5);
        spot.position.set(x, 9, 0); spot.castShadow = false;
        const t = new THREE.Object3D(); t.position.set(x, 0, 0);
        scene.add(t); spot.target = t; scene.add(spot); scene.add(t);
    });
}

function addEnvironment() {
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshStandardMaterial({ color: 0x080d1a, roughness: 0.85, metalness: 0.3 })
    );
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(200, 200, 0x1a2a4a, 0x141e30);
    grid.material.opacity = 0.45; grid.material.transparent = true; scene.add(grid);
    const ceil = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 100),
        new THREE.MeshStandardMaterial({ color: 0x050810, roughness: 1, side: THREE.BackSide })
    );
    ceil.position.y = 25; ceil.rotation.x = Math.PI / 2; scene.add(ceil);
    [[-60, 0], [60, Math.PI]].forEach(([x, ry]) => {
        const wall = new THREE.Mesh(
            new THREE.PlaneGeometry(100, 30),
            new THREE.MeshStandardMaterial({ color: 0x09101f, roughness: 1, side: THREE.BackSide })
        );
        wall.position.set(x, 6, 0); wall.rotation.y = ry + Math.PI / 2; scene.add(wall);
    });
    const back = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 30),
        new THREE.MeshStandardMaterial({ color: 0x09101f, roughness: 1, side: THREE.BackSide })
    );
    back.position.set(0, 6, -60); scene.add(back);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xe53935, opacity: 0.25, transparent: true });
    [-0.9, 0.9].forEach(x => {
        const line = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 8), lineMat);
        line.rotation.x = -Math.PI / 2; line.position.set(x, 0.001, 0); scene.add(line);
    });
}

function buildCar(bodyColor, trimColor) {
    const group = new THREE.Group();
    const mBody  = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.25, metalness: 0.75 });
    const mTrim  = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.45, metalness: 0.4 });
    const mBlack = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.85, metalness: 0.1 });
    const mGlass = new THREE.MeshStandardMaterial({ color: 0x6699bb, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.65 });
    const mChrome= new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.1, metalness: 0.95 });
    const mLight = new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 0.6 });
    const mTail  = new THREE.MeshStandardMaterial({ color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.7 });
    function mesh(geo, mat, x, y, z, rx, ry, rz) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x || 0, y || 0, z || 0);
        if (rx) m.rotation.x = rx; if (ry) m.rotation.y = ry; if (rz) m.rotation.z = rz;
        m.castShadow = true; group.add(m); return m;
    }
    mesh(new THREE.BoxGeometry(1.82, 0.44, 3.7),  mBody,  0, 0.5,  0);
    mesh(new THREE.BoxGeometry(1.32, 0.42, 1.65), mBody,  0, 0.93,-0.08);
    mesh(new THREE.BoxGeometry(1.14, 0.36, 0.06), mGlass, 0, 0.88, 0.75, 0.3);
    mesh(new THREE.BoxGeometry(1.14, 0.3,  0.06), mGlass, 0, 0.86,-0.91,-0.3);
    mesh(new THREE.BoxGeometry(1.72, 0.22, 0.14), mTrim,  0, 0.3,  1.88);
    mesh(new THREE.BoxGeometry(1.72, 0.22, 0.14), mTrim,  0, 0.3, -1.88);
    mesh(new THREE.BoxGeometry(1.62, 0.06, 0.26), mTrim,  0, 1.08,-1.82);
    [-0.76, 0.76].forEach(x => mesh(new THREE.BoxGeometry(0.05, 0.3, 0.08), mTrim, x, 0.92,-1.77));
    [-0.67, 0.67].forEach(x => mesh(new THREE.BoxGeometry(0.26, 0.13, 0.05), mLight, x, 0.6, 1.85));
    [-0.67, 0.67].forEach(x => mesh(new THREE.BoxGeometry(0.32, 0.11, 0.05), mTail,  x, 0.5,-1.86));
    [-0.92, 0.92].forEach(x => mesh(new THREE.BoxGeometry(0.08, 0.12, 3.2),  mTrim,  x, 0.28, 0));
    const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 24);
    const hubGeo   = new THREE.CylinderGeometry(0.15, 0.15, 0.24, 18);
    [
        { x: -1.02, z:  1.12 }, { x:  1.02, z:  1.12 },
        { x: -1.02, z: -1.12 }, { x:  1.02, z: -1.12 },
    ].forEach(({ x, z }) => {
        const tire = new THREE.Mesh(wheelGeo, mBlack);
        tire.rotation.z = Math.PI / 2; tire.position.set(x, 0.33, z); tire.castShadow = true; group.add(tire);
        const hub = new THREE.Mesh(hubGeo, mChrome);
        hub.rotation.z = Math.PI / 2; hub.position.set(x, 0.33, z); group.add(hub);
    });
    group.rotation.y = Math.PI; return group;
}

function swapVariant(index) {
    activeVariant = index;
    window._activeVariant = index;
    const v = CAR_VARIANTS[index];
    document.querySelectorAll('.car-thumb').forEach((el) => {
        const idx = parseInt(el.getAttribute('data-variant-index'), 10);
        const active = idx === index;
        el.classList.toggle('active', active);
        el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const titleEl = document.getElementById('car-title');
    if (titleEl) titleEl.textContent = 'Riley-X1 \u00b7 ' + v.name;
    const sl = document.getElementById('spec-livery');
    if (sl) sl.textContent = v.name;
    // Update availability for the newly selected car
    const statusMap = window._carStatusMap || {};
    const mappedSt = statusMap[v.id];
    const newSt = (mappedSt != null) ? mappedSt : (window._carAvailabilityStatus || 'available');
    if (newSt !== window._carAvailabilityStatus) {
        window._carAvailabilityStatus = newSt;
    }
    // Always update CTA and badge for the newly selected car
    if (typeof updateCTA === 'function') updateCTA();
    if (typeof renderAvailabilityBadge === 'function') renderAvailabilityBadge();
    if (!scene || !renderer) return;
    scene.remove(carGroup);
    carGroup = buildCar(v.body, v.trim);
    scene.add(carGroup);
}

function renderCarousel() {
    const el = document.getElementById('car-carousel');
    if (!el) return;
    el.innerHTML = '';
    const fc  = (document.getElementById('filter-class') || {}).value || 'all';
    const ft  = (document.getElementById('filter-type')  || {}).value || 'all';
    const fa  = (document.getElementById('filter-avail') || {}).value || 'all';
    const srch= ((document.getElementById('carousel-search') || {}).value || '').toLowerCase().trim();
    const carStatusMap = window._carStatusMap || {};
    const globalSt = window._carAvailabilityStatus || 'available';
    let any = false;
    CAR_VARIANTS.forEach((v, i) => {
        if (fc !== 'all' && v.cls  !== fc) return;
        if (ft !== 'all' && v.type !== ft) return;
        const mappedSt = carStatusMap[v.id];
        const vSt = (mappedSt != null) ? mappedSt : (i === activeVariant ? globalSt : 'available');
        if (fa !== 'all') {
            if (fa === 'available' && (vSt === 'busy' || vSt === 'offline' || vSt === 'maintenance')) return;
            if (fa === 'busy'      && vSt !== 'busy')  return;
        }
        if (srch && !v.name.toLowerCase().includes(srch)) return;
        any = true;
        const thumb = document.createElement('div');
        let thumbCls = 'car-thumb' + (i === activeVariant ? ' active' : '');
        if (vSt === 'busy')        thumbCls += ' car-busy';
        if (vSt === 'offline')     thumbCls += ' car-offline';
        if (vSt === 'maintenance') thumbCls += ' car-maintenance';
        thumb.className = thumbCls;
        thumb.setAttribute('role', 'option');
        thumb.setAttribute('aria-label', v.name);
        thumb.setAttribute('aria-selected', i === activeVariant ? 'true' : 'false');
        thumb.setAttribute('data-variant-index', i);
        thumb.title = v.name;
        thumb.innerHTML =
            '<div class="thumb-car-img" aria-hidden="true">\uD83C\uDFCE\uFE0F</div>' +
            '<div class="thumb-name">' + v.name + '</div>' +
            '<div class="thumb-avail"></div>';
        var thumbImg = thumb.querySelector('.thumb-car-img');
        if (thumbImg) thumbImg.style.color = v.bodyHex;
        thumb.addEventListener('click', () => swapVariant(i));
        el.appendChild(thumb);
    });
    if (!any) {
        const empty = document.createElement('div');
        empty.className = 'carousel-empty';
        empty.textContent = 'Нет авто по фильтру';
        el.appendChild(empty);
    }
}

window._renderCarousel = renderCarousel;

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    if (carGroup && autoRotate) carGroup.rotation.y += 0.0015;
    renderer.render(scene, camera);
    fpsCounter++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
        currentFps = fpsCounter; fpsCounter = 0; lastFpsTime = now;
        const fpsEl = document.getElementById('sb-fps');
        if (fpsEl) fpsEl.textContent = currentFps;
    }
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
