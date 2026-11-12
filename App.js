import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, ActivityIndicator, Animated, Easing,
  StyleSheet, useWindowDimensions, AppState, Modal, Switch, Pressable, ScrollView, Alert, BackHandler,
  PermissionsAndroid, Platform, Vibration,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';
import Native from './modules/pochette-native';

WebBrowser.maybeCompleteAuthSession();

const APP_VERSION = '1.6';
const REDIRECT_URI = 'pochette://callback';
const SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];
const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};
// additional_types=episode : sans ce paramètre, Spotify ne renvoie rien pour les podcasts
const API_URL = 'https://api.spotify.com/v1/me/player/currently-playing?additional_types=episode';

const POLL_PLAYING_MS = 4000;
const POLL_IDLE_MS = 10000;
const UI_HIDE_MS = 4000;

const ACCENTS = ['#ffffff', '#1db954', '#ff5c8a', '#4da3ff', '#ffb547', '#b48cff'];

const DEFAULT_PREFS = {
  showInfo: true,
  showProgress: true,
  progressStyle: 'wave', // wave | line
  showClock: false,
  clockType: 'classic',  // classic | flip
  clockPosition: 'info', // info | top
  clockSize: 'M',        // S | M | L | XL
  clockWeight: 'thin',   // thin | regular | bold
  clockFont: 'default',  // default | serif | mono | condensed
  clockColor: '#ffffff',
  clockSeconds: false,
  clockDate: false,
  clock12h: false,
  coverStyle: 'cover', // cover | vinyl | sleeve
  vinylSpeed: '33',    // 33 | 45 tours/min
  bgStyle: 'blur',     // blur | black | cover
  corners: 'round',    // round | square
  accent: '#ffffff',
  nightMode: false,
  antiBurnIn: true,
  showLyrics: false,
  timerWork: 25,       // minutes de travail
  timerBreak: 5,       // minutes de pause
  timerCycles: 4,      // nombre de sessions
  timerFocus: false,   // active le mode « Pochette – Travail » sur le téléphone
  timerVibrate: true,
};

// ---------- Stockage sécurisé ----------
const sget = async (k) => { try { return await SecureStore.getItemAsync(k); } catch { return null; } };
const sset = async (k, v) => { try { await SecureStore.setItemAsync(k, String(v)); } catch {} };
const sdel = async (k) => { try { await SecureStore.deleteItemAsync(k); } catch {} };

const form = (o) =>
  Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function tokenRequest(clientId, params) {
  const res = await fetch(DISCOVERY.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: clientId, ...params }),
  });
  if (!res.ok) { const e = new Error('token'); e.status = res.status; throw e; }
  return res.json();
}

function normalize(data) {
  const item = data && data.item;
  if (!item) return null;
  const images = (item.album && item.album.images) || item.images || (item.show && item.show.images) || [];
  const artists = item.artists
    ? item.artists.map((a) => a.name).join(', ')
    : (item.show && item.show.publisher) || '';
  return {
    id: item.id || item.uri || item.name,
    title: item.name,
    artist: artists,
    album: (item.album && item.album.name) || (item.show && item.show.name) || '',
    image: images[0] ? images[0].url : null,
    isPlaying: !!data.is_playing,
    progressMs: data.progress_ms || 0,
    fetchedAt: Date.now(),
    durationMs: item.duration_ms || 0,
  };
}

// ---------- Petits composants ----------

// La nouvelle image apparaît par-dessus l'ancienne, retirée une fois le fondu terminé.
function CrossfadeImage({ uri, style, blurRadius }) {
  const [layers, setLayers] = useState(() => (uri ? [{ uri, anim: new Animated.Value(0) }] : []));
  useEffect(() => {
    if (!uri) { setLayers([]); return; }
    setLayers((prev) => {
      if (prev.length && prev[prev.length - 1].uri === uri) return prev;
      return [...prev.slice(-1), { uri, anim: new Animated.Value(0) }];
    });
  }, [uri]);
  return (
    <View style={[style, { overflow: 'hidden' }]} pointerEvents="none">
      {layers.map((layer) => (
        <Animated.Image
          key={layer.uri}
          source={{ uri: layer.uri }}
          blurRadius={blurRadius}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { opacity: layer.anim }]}
          onLoad={() =>
            Animated.timing(layer.anim, { toValue: 1, duration: 700, useNativeDriver: true }).start(() =>
              setLayers((prev) => (prev.length > 1 && prev[prev.length - 1] === layer ? [layer] : prev)))
          }
        />
      ))}
    </View>
  );
}

const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const CLOCK_SIZES = { S: 32, M: 48, L: 68, XL: 92 };
const CLOCK_WEIGHTS = { thin: '200', regular: '400', bold: '700' };
const CLOCK_FONTS = { default: undefined, serif: 'serif', mono: 'monospace', condensed: 'sans-serif-condensed' };


// ---------- Barre de progression en vagues (style Samsung / Android) ----------
const WAVE_H = 16;      // hauteur de la zone
const WAVE_AMP = 3.2;   // hauteur des vagues
const WAVE_LEN = 24;    // longueur d'une vague
const WAVE_STROKE = 3;  // épaisseur du trait

function WaveProgress({ progress, playing, color }) {
  const [w, setW] = useState(0);
  const phase = useRef(new Animated.Value(0)).current;
  const live = useRef(new Animated.Value(playing ? 1 : 0)).current;

  // les vagues avancent en continu
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(phase, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // en pause, la vague s'aplatit en ligne droite
  useEffect(() => {
    Animated.timing(live, { toValue: playing ? 1 : 0, duration: 450, useNativeDriver: true }).start();
  }, [playing]);

  // la vague est dessinée avec de petits segments (pas besoin de bibliothèque)
  const segments = useMemo(() => {
    if (!w) return [];
    const pts = [];
    for (let x = 0; x <= w + WAVE_LEN; x += 3) {
      pts.push([x, WAVE_H / 2 + WAVE_AMP * Math.sin((x / WAVE_LEN) * 2 * Math.PI)]);
    }
    return pts.slice(1).map(([x1, y1], i) => {
      const [x0, y0] = pts[i];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy) + 1;
      return { left: (x0 + x1) / 2 - len / 2, top: (y0 + y1) / 2 - WAVE_STROKE / 2, width: len, angle: Math.atan2(dy, dx) };
    });
  }, [w]);

  const played = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const shift = phase.interpolate({ inputRange: [0, 1], outputRange: [0, -WAVE_LEN] });
  const flat = live.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const mid = WAVE_H / 2 - WAVE_STROKE / 2;

  return (
    <View style={{ height: WAVE_H, marginTop: 14 }} onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}>
      {/* reste à écouter : ligne droite discrète */}
      <Animated.View
        style={{ position: 'absolute', left: played, right: 0, top: mid, height: WAVE_STROKE, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)' }}
      />
      {/* déjà écouté : la vague */}
      <Animated.View style={{ position: 'absolute', left: 0, top: 0, height: WAVE_H, width: played, overflow: 'hidden' }}>
        <Animated.View style={{ width: w + WAVE_LEN, height: WAVE_H, opacity: live, transform: [{ translateX: shift }] }}>
          {segments.map((g, i) => (
            <View
              key={i}
              style={{
                position: 'absolute', left: g.left, top: g.top, width: g.width, height: WAVE_STROKE,
                borderRadius: WAVE_STROKE / 2, backgroundColor: color, transform: [{ rotate: `${g.angle}rad` }],
              }}
            />
          ))}
        </Animated.View>
        <Animated.View
          style={{ position: 'absolute', left: 0, width: w, top: mid, height: WAVE_STROKE, borderRadius: 2, backgroundColor: color, opacity: flat }}
        />
      </Animated.View>
      {/* curseur */}
      <Animated.View
        style={{ position: 'absolute', left: played, marginLeft: -2, top: WAVE_H / 2 - 8, width: 4, height: 16, borderRadius: 2, backgroundColor: color }}
      />
    </View>
  );
}

// ---------- Vinyle qui tourne ----------
// 33 ⅓ tours/min = 1,8 s par tour ; 45 tours/min = 1,33 s par tour
function Vinyl({ uri, size, playing, speed = '33' }) {
  const spin = useRef(new Animated.Value(0)).current;
  const turns = useRef(0);        // angle accumulé (en tours) quand le disque est arrêté
  const revMs = speed === '45' ? 1333 : 1800;

  useEffect(() => {
    if (!playing) return undefined;
    const startedAt = Date.now();
    spin.setOffset(turns.current % 1);
    spin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: revMs, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => {
      // on mémorise l'angle atteint pour repartir de là, sans à-coup
      loop.stop();
      turns.current += (Date.now() - startedAt) / revMs;
      spin.setOffset(turns.current % 1);
      spin.setValue(0);
    };
  }, [playing, revMs]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
  const label = size * 0.4;
  const grooves = [0.95, 0.89, 0.83, 0.77, 0.71, 0.65, 0.59, 0.53, 0.47];

  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#0e0e0e', elevation: 16 }}>
      <Animated.View style={[StyleSheet.absoluteFill, s.center, { transform: [{ rotate }] }]}>
        {grooves.map((k) => (
          <View
            key={k}
            style={{
              position: 'absolute', width: size * k, height: size * k, borderRadius: (size * k) / 2,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
            }}
          />
        ))}
        {uri ? (
          <Image source={{ uri }} style={{ width: label, height: label, borderRadius: label / 2 }} />
        ) : (
          <View style={{ width: label, height: label, borderRadius: label / 2, backgroundColor: '#3a3a3a' }} />
        )}
        <View style={{ position: 'absolute', width: size * 0.035, height: size * 0.035, borderRadius: size, backgroundColor: '#000' }} />
      </Animated.View>
      {/* Reflets fixes : ils ne tournent pas, comme sur un vrai disque */}
      <View
        pointerEvents="none"
        style={{
          ...StyleSheet.absoluteFillObject,
          borderRadius: size / 2,
          borderWidth: size * 0.26,
          borderTopColor: 'rgba(255,255,255,0.08)',
          borderBottomColor: 'rgba(255,255,255,0.05)',
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          transform: [{ rotate: '-30deg' }],
        }}
      />
    </View>
  );
}

// Pochette avec le vinyle qui dépasse sur le côté
function Sleeve({ uri, width, playing, speed, radius }) {
  const sz = width / 1.42;
  return (
    <View style={{ width, height: sz }}>
      <View style={{ position: 'absolute', left: width - sz * 0.99, top: sz * 0.02 }}>
        <Vinyl uri={uri} size={sz * 0.96} playing={playing} speed={speed} />
      </View>
      <View style={[s.coverWrap, { position: 'absolute', left: 0, top: 0, width: sz, height: sz, borderRadius: radius }]}>
        {uri ? <CrossfadeImage uri={uri} style={{ width: sz, height: sz, borderRadius: radius }} /> : null}
      </View>
    </View>
  );
}


// ---------- Horloge basculante (à palettes) ----------
const FLIP_WEIGHTS = { thin: '400', regular: '600', bold: '800' };

// Une moitié de carte : on affiche le chiffre entier et on n'en laisse voir que le haut ou le bas
function FlipHalf({ digit, part, w, h, color, fontFamily, fontWeight, radius }) {
  const top = part === 'top';
  return (
    <View
      style={{
        position: 'absolute', left: 0, top: top ? 0 : h / 2, width: w, height: h / 2, overflow: 'hidden',
        backgroundColor: '#161616',
        borderTopLeftRadius: top ? radius : 0, borderTopRightRadius: top ? radius : 0,
        borderBottomLeftRadius: top ? 0 : radius, borderBottomRightRadius: top ? 0 : radius,
      }}
    >
      <Text
        style={{
          position: 'absolute', left: 0, top: top ? 0 : -h / 2, width: w, height: h,
          lineHeight: h, fontSize: h * 0.66, textAlign: 'center', textAlignVertical: 'center',
          includeFontPadding: false, color, fontFamily, fontWeight, fontVariant: ['tabular-nums'],
        }}
      >
        {digit}
      </Text>
    </View>
  );
}

function FlipDigit({ value, w, h, color, fontFamily, fontWeight }) {
  const [cur, setCur] = useState(value);
  const [prev, setPrev] = useState(value);
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (value === cur) return;
    setPrev(cur);
    setCur(value);
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
  }, [value]);

  const radius = h * 0.06;
  const common = { w, h, color, fontFamily, fontWeight, radius };
  // 1re moitié de l'animation : le haut de l'ancien chiffre bascule vers le bas
  const topRot = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['0deg', '-90deg', '-90deg'] });
  // 2e moitié : le bas du nouveau chiffre retombe à plat
  const bottomRot = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['90deg', '90deg', '0deg'] });
  const shade = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.45, 0] });

  return (
    <View style={{ width: w, height: h }}>
      <FlipHalf digit={cur} part="top" {...common} />
      <FlipHalf digit={prev} part="bottom" {...common} />
      <Animated.View
        style={{ position: 'absolute', left: 0, top: 0, width: w, height: h / 2, transformOrigin: 'bottom', transform: [{ perspective: h * 6 }, { rotateX: topRot }] }}
      >
        <FlipHalf digit={prev} part="top" {...common} h={h} />
        <Animated.View style={{ position: 'absolute', left: 0, top: 0, width: w, height: h / 2, backgroundColor: '#000', opacity: shade, borderTopLeftRadius: radius, borderTopRightRadius: radius }} />
      </Animated.View>
      <Animated.View
        style={{ position: 'absolute', left: 0, top: h / 2, width: w, height: h / 2, transformOrigin: 'top', transform: [{ perspective: h * 6 }, { rotateX: bottomRot }] }}
      >
        <View style={{ position: 'absolute', left: 0, top: -h / 2, width: w, height: h }}>
          <FlipHalf digit={cur} part="bottom" {...common} />
        </View>
      </Animated.View>
      {/* fente au milieu de la carte */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: h / 2 - 0.75, height: 1.5, backgroundColor: 'rgba(0,0,0,0.75)' }} />
    </View>
  );
}

function FlipClock({ time, suffix, date, size, color, fontFamily, weight, align }) {
  const { width: sw } = useWindowDimensions();
  const chars = time.split('');
  const nDigits = chars.filter((c) => c !== ':').length;
  const nSeps = chars.length - nDigits;
  let h = size * 1.5;
  const total = (hh) => nDigits * hh * 0.78 + (chars.length - 1) * hh * 0.06 + nSeps * hh * 0.2;
  const k = Math.min(1, (sw * 0.9) / total(h)); // on rétrécit si ça ne tient pas en largeur
  h *= k;
  const w = h * 0.78;
  const gap = h * 0.06;
  const fontWeight = FLIP_WEIGHTS[weight] || '800';

  return (
    <View style={{ alignItems: align === 'left' ? 'flex-start' : 'center', marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {chars.map((c, i) => (
          <View key={i} style={{ marginLeft: i ? gap : 0 }}>
            {c === ':' ? (
              <View style={{ width: h * 0.2, height: h, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: h * 0.07, height: h * 0.07, borderRadius: h, backgroundColor: color, opacity: 0.8, marginBottom: h * 0.14 }} />
                <View style={{ width: h * 0.07, height: h * 0.07, borderRadius: h, backgroundColor: color, opacity: 0.8 }} />
              </View>
            ) : (
              <FlipDigit value={c} w={w} h={h} color={color} fontFamily={fontFamily} fontWeight={fontWeight} />
            )}
          </View>
        ))}
        {!!suffix && <Text style={{ color, fontSize: h * 0.25, fontWeight: '700', marginLeft: gap * 2 }}>{suffix.trim()}</Text>}
      </View>
      {!!date && (
        <Text style={{ color, opacity: 0.75, fontSize: Math.max(13, h * 0.2), fontFamily, marginTop: h * 0.12 }}>{date}</Text>
      )}
    </View>
  );
}

function Clock({ p, scale = 1, align = 'center' }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const unit = p.clockSeconds ? 1000 : 60000;
    let t;
    const schedule = () => {
      t = setTimeout(() => { setNow(new Date()); schedule(); }, unit - (Date.now() % unit) + 30);
    };
    setNow(new Date());
    schedule();
    return () => clearTimeout(t);
  }, [p.clockSeconds]);

  const pad = (n) => String(n).padStart(2, '0');
  let h = now.getHours();
  let suffix = '';
  if (p.clock12h) { suffix = h < 12 ? ' AM' : ' PM'; h = h % 12 || 12; }
  const time = `${p.clock12h ? h : pad(h)}:${pad(now.getMinutes())}${p.clockSeconds ? `:${pad(now.getSeconds())}` : ''}`;
  const date = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  const size = (CLOCK_SIZES[p.clockSize] || 48) * scale;
  const fontFamily = CLOCK_FONTS[p.clockFont];
  const color = p.clockColor || '#ffffff';

  if (p.clockType === 'flip') {
    return (
      <FlipClock
        time={time}
        suffix={suffix}
        date={p.clockDate ? date : ''}
        size={size}
        color={color}
        fontFamily={fontFamily}
        weight={p.clockWeight}
        align={align}
      />
    );
  }

  return (
    <View style={{ alignItems: align === 'left' ? 'flex-start' : 'center', marginBottom: 8 }}>
      <Text
        style={{
          color, fontSize: size, lineHeight: size * 1.15, fontFamily,
          fontWeight: CLOCK_WEIGHTS[p.clockWeight] || '200', fontVariant: ['tabular-nums'],
        }}
      >
        {time}
        {!!suffix && <Text style={{ fontSize: size * 0.35 }}>{suffix}</Text>}
      </Text>
      {p.clockDate && (
        <Text style={{ color, opacity: 0.75, fontSize: Math.max(13, size * 0.28), fontFamily, marginTop: 2 }}>
          {date}
        </Text>
      )}
    </View>
  );
}

function ColorRow({ label, value, onChange }) {
  return (
    <View style={{ paddingVertical: 8 }}>
      <Text style={s.rowText}>{label}</Text>
      <View style={s.chips}>
        {ACCENTS.map((c) => (
          <TouchableOpacity
            key={c}
            onPress={() => onChange(c)}
            style={[s.swatch, { backgroundColor: c }, value === c && s.swatchOn]}
          />
        ))}
      </View>
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Toggle({ label, value, onChange, disabled, hint }) {
  return (
    <View style={[s.row, disabled && { opacity: 0.4 }]}>
      <View style={{ flex: 1, marginRight: 12 }}>
        <Text style={s.rowText}>{label}</Text>
        {!!hint && <Text style={s.hint}>{hint}</Text>}
      </View>
      <Switch
        value={!!value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: '#1db954', false: '#555' }}
        thumbColor="#fff"
      />
    </View>
  );
}

function Choice({ label, value, options, onChange, disabled }) {
  return (
    <View style={[{ paddingVertical: 8 }, disabled && { opacity: 0.4 }]}>
      <Text style={s.rowText}>{label}</Text>
      <View style={s.chips}>
        {options.map(([v, l]) => (
          <TouchableOpacity
            key={v}
            disabled={disabled}
            onPress={() => onChange(v)}
            style={[s.chip, value === v && s.chipOn]}
          >
            <Text style={[s.chipText, value === v && s.chipTextOn]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function ActionButton({ label, onPress, secondary, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[secondary ? s.btnSecondary : s.btn, { marginTop: 10 }, disabled && { opacity: 0.4 }]}
    >
      <Text style={secondary ? s.btnSecondaryText : s.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}


// ---------- Bluetooth & enceintes ----------
const BT_ICONS = {
  speaker: '🔊', audio: '🔊', headphones: '🎧', car: '🚗', tv: '📺',
  watch: '⌚', phone: '📱', computer: '💻', peripheral: '⌨️', other: '🔵',
};
const AUDIO_KINDS = ['speaker', 'audio', 'headphones', 'car', 'tv'];

async function askBluetoothPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 31) return true;
  const res = await PermissionsAndroid.requestMultiple([
    'android.permission.BLUETOOTH_SCAN',
    'android.permission.BLUETOOTH_CONNECT',
  ]);
  return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}

function DeviceRow({ d, onPress, right }) {
  const status = d.active ? 'Joue la musique' : d.connected ? 'Connecté' : d.pairing ? 'Appairage…' : d.paired ? 'Appairé' : 'Disponible';
  return (
    <TouchableOpacity style={s.btRow} onPress={onPress} disabled={!onPress}>
      <View style={[s.btIcon, d.active && { backgroundColor: '#1db954' }]}>
        <Text style={{ fontSize: 20 }}>{BT_ICONS[d.kind] || '🔵'}</Text>
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text numberOfLines={1} style={s.btName}>{d.name}</Text>
        <Text style={[s.btStatus, (d.active || d.connected) && { color: '#1db954', opacity: 1 }]}>{status}</Text>
      </View>
      {right}
    </TouchableOpacity>
  );
}

function BluetoothPanel({ visible, onClose }) {
  const [st, setSt] = useState({ supported: true, enabled: false, permission: false, scanning: false });
  const [paired, setPaired] = useState([]);
  const [found, setFound] = useState({});
  const [scanning, setScanning] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(() => {
    if (!Native) return;
    try {
      setSt(Native.btState());
      setPaired(Native.btDevices());
    } catch {}
  }, []);

  useEffect(() => {
    if (!visible || !Native) return undefined;
    (async () => { await askBluetoothPermission(); refresh(); })();
    const sub = Native.addListener('onBluetooth', (e) => {
      if (e.type === 'found' && e.device) {
        setFound((f) => ({ ...f, [e.device.address]: e.device }));
      } else if (e.type === 'scanFinished') {
        setScanning(false);
      } else {
        refresh();
      }
    });
    const app = AppState.addEventListener('change', (a) => { if (a === 'active') refresh(); });
    const timer = setInterval(refresh, 5000);
    return () => {
      sub.remove(); app.remove(); clearInterval(timer);
      try { Native.btStopScan(); } catch {}
      setScanning(false);
    };
  }, [visible, refresh]);

  async function scan() {
    if (!(await askBluetoothPermission())) {
      Alert.alert('Bluetooth', 'Autorise « Appareils à proximité » pour rechercher des enceintes.');
      return;
    }
    setFound({});
    const ok = Native.btStartScan();
    setScanning(!!ok);
    if (!ok) Alert.alert('Bluetooth', 'Impossible de lancer la recherche. Vérifie que le Bluetooth est activé.');
  }

  function pair(d) {
    const ok = Native.btPair(d.address);
    if (!ok) Alert.alert('Appairage', 'L\'appairage n\'a pas pu démarrer. Mets l\'enceinte en mode appairage et réessaie.');
    setTimeout(refresh, 1500);
  }

  const openOutput = () => Native.btOpenOutput().catch(() => Native.btOpenSettings());

  const pairedSorted = [...paired].sort((a, b) =>
    (b.active - a.active) || (b.connected - a.connected)
    || (AUDIO_KINDS.includes(b.kind) - AUDIO_KINDS.includes(a.kind)) || a.name.localeCompare(b.name));
  const visiblePaired = showAll ? pairedSorted : pairedSorted.filter((d) => AUDIO_KINDS.includes(d.kind) || d.connected);
  const pairedAddrs = new Set(paired.map((d) => d.address));
  const newDevices = Object.values(found)
    .filter((d) => !pairedAddrs.has(d.address))
    .sort((a, b) => (AUDIO_KINDS.includes(b.kind) - AUDIO_KINDS.includes(a.kind)) || a.name.localeCompare(b.name));
  const activeCount = paired.filter((d) => d.active).length;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.screen, { paddingTop: 44 }]}>
        <View style={s.btHeader}>
          <Text style={s.h1}>Bluetooth & enceintes</Text>
          <TouchableOpacity onPress={onClose} style={s.btClose}><Text style={{ color: '#fff', fontSize: 18 }}>✕</Text></TouchableOpacity>
        </View>

        {!Native ? (
          <Text style={[s.p, { padding: 20 }]}>Disponible uniquement dans l'appli installée sur Android.</Text>
        ) : !st.supported ? (
          <Text style={[s.p, { padding: 20 }]}>Ce téléphone n'a pas de Bluetooth.</Text>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
            {!st.permission && (
              <View style={s.btCard}>
                <Text style={s.p}>Pochette a besoin de l'autorisation « Appareils à proximité » pour voir tes enceintes.</Text>
                <ActionButton label="Autoriser" onPress={async () => { await askBluetoothPermission(); refresh(); }} />
              </View>
            )}

            {!st.enabled ? (
              <View style={s.btCard}>
                <Text style={s.btBig}>Le Bluetooth est désactivé</Text>
                <ActionButton label="Activer le Bluetooth" onPress={() => { Native.btEnable(); setTimeout(refresh, 1500); }} />
              </View>
            ) : (
              <>
                {/* Sortie audio : le geste principal */}
                <View style={[s.btCard, { borderColor: '#1db954' }]}>
                  <Text style={s.btBig}>
                    {activeCount > 1 ? `🔊 Musique sur ${activeCount} appareils` : activeCount === 1 ? '🔊 Musique sur 1 appareil' : '📱 Musique sur le téléphone'}
                  </Text>
                  <ActionButton label="Choisir où jouer la musique" onPress={openOutput} />
                  <Text style={[s.hint, { marginTop: 10 }]}>
                    Pour jouer sur 2 enceintes en même temps, même de marques différentes : connecte-les toutes les deux,
                    touche le bouton ci-dessus et coche-les. Les Samsung gèrent jusqu'à 2 appareils (« Dual Audio »).
                  </Text>
                </View>

                <Text style={s.subTitle}>Mes appareils</Text>
                {visiblePaired.length === 0 ? (
                  <Text style={s.hint}>Aucun appareil audio appairé pour l'instant. Utilise « Rechercher » ci-dessous.</Text>
                ) : (
                  visiblePaired.map((d) => <DeviceRow key={d.address} d={d} onPress={openOutput} />)
                )}
                <TouchableOpacity onPress={() => setShowAll((v) => !v)} style={{ paddingVertical: 10 }}>
                  <Text style={[s.hint, { textDecorationLine: 'underline' }]}>
                    {showAll ? 'Afficher seulement l\'audio' : 'Afficher tous les appareils (montres, PC…)'}
                  </Text>
                </TouchableOpacity>

                <Text style={s.subTitle}>Ajouter une enceinte</Text>
                <Text style={s.hint}>Mets l'enceinte en mode appairage (souvent un appui long sur le bouton Bluetooth), puis lance la recherche.</Text>
                <ActionButton
                  secondary
                  label={scanning ? 'Recherche en cours…  (toucher pour arrêter)' : 'Rechercher'}
                  onPress={() => { if (scanning) { Native.btStopScan(); setScanning(false); } else scan(); }}
                />
                {scanning && <ActivityIndicator color="#1db954" style={{ marginTop: 12 }} />}
                {newDevices.map((d) => (
                  <DeviceRow
                    key={d.address}
                    d={d}
                    onPress={() => pair(d)}
                    right={<Text style={s.btAction}>Appairer</Text>}
                  />
                ))}
                {!scanning && Object.keys(found).length > 0 && newDevices.length === 0 && (
                  <Text style={[s.hint, { marginTop: 8 }]}>Aucun nouvel appareil trouvé.</Text>
                )}
              </>
            )}

            <TouchableOpacity onPress={() => Native.btOpenSettings()} style={{ paddingVertical: 18, alignItems: 'center' }}>
              <Text style={[s.hint, { textDecorationLine: 'underline' }]}>Réglages Bluetooth du téléphone</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}


// ---------- Paroles (base ouverte LRCLIB) ----------
function parseLrc(text) {
  const out = [];
  const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const raw of text.split('\n')) {
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      out.push({ t: (parseInt(m[1], 10) * 60 + parseFloat(m[2])) * 1000, text: words });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

async function fetchLyrics(t) {
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const artist = (t.artist || '').split(',')[0].trim();
  const headers = { 'Lrclib-Client': `Pochette ${APP_VERSION}` };
  const toResult = (d) => {
    if (!d) return { status: 'none' };
    if (d.instrumental) return { status: 'instrumental' };
    if (d.syncedLyrics) return { status: 'synced', lines: parseLrc(d.syncedLyrics) };
    if (d.plainLyrics) return { status: 'plain', lines: d.plainLyrics.split('\n').map((x) => x.trim()).filter(Boolean) };
    return { status: 'none' };
  };
  const params = { track_name: t.title, artist_name: artist, album_name: t.album, duration: Math.round((t.durationMs || 0) / 1000) || undefined };
  let res = await fetch(`https://lrclib.net/api/get?${q(params)}`, { headers });
  if (res.ok) return toResult(await res.json());
  // pas de correspondance exacte : on cherche la plus proche
  res = await fetch(`https://lrclib.net/api/search?${q({ track_name: t.title, artist_name: artist })}`, { headers });
  if (!res.ok) return { status: 'none' };
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return { status: 'none' };
  const dur = (t.durationMs || 0) / 1000;
  const best = [...list].sort((a, b) =>
    (!!b.syncedLyrics - !!a.syncedLyrics) || (Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur)))[0];
  return toResult(best);
}

function LyricsView({ lyrics, track, align = 'center' }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!track || !track.isPlaying) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 300);
    return () => clearInterval(id);
  }, [track && track.isPlaying, track && track.fetchedAt]);

  const msg = (txt) => <Text style={[s.lyricDim, { textAlign: align, marginTop: 12 }]}>{txt}</Text>;
  if (!lyrics || lyrics.status === 'loading') return msg('Recherche des paroles…');
  if (lyrics.status === 'instrumental') return msg('♪ Morceau instrumental');
  if (lyrics.status === 'error') return msg('Paroles indisponibles (connexion ?)');
  if (lyrics.status !== 'synced' && lyrics.status !== 'plain') return msg('Paroles introuvables pour ce titre');

  const pos = Math.min(
    track.durationMs || Infinity,
    track.progressMs + (track.isPlaying ? Date.now() - (track.fetchedAt || Date.now()) : 0),
  );
  const lines = lyrics.lines;
  let idx;
  if (lyrics.status === 'synced') {
    idx = -1;
    for (let i = 0; i < lines.length; i += 1) { if (lines[i].t <= pos + 250) idx = i; else break; }
  } else {
    idx = Math.floor((pos / (track.durationMs || 1)) * lines.length);
  }
  const textOf = (l) => (typeof l === 'string' ? l : l.text) || '♪';
  const start = Math.max(0, idx - 1);
  const shown = lines.slice(start, start + 5);

  return (
    <View style={{ marginTop: 14 }}>
      {shown.map((l, k) => {
        const i = start + k;
        const current = i === idx;
        return (
          <Text
            key={i}
            numberOfLines={2}
            style={[current ? s.lyricNow : s.lyricDim, { textAlign: align, opacity: current ? 1 : i < idx ? 0.3 : 0.5 }]}
          >
            {textOf(l)}
          </Text>
        );
      })}
      {lyrics.status === 'plain' && <Text style={[s.hint, { textAlign: align, marginTop: 6 }]}>Paroles non synchronisées : défilement approximatif</Text>}
    </View>
  );
}

// ---------- Minuteur de travail ----------
const fmtTime = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};

const IDLE_TIMER = { phase: 'idle', endAt: 0, remaining: 0, paused: false, cycle: 1 };

function useWorkTimer(prefs) {
  const [t, setT] = useState(IDLE_TIMER);
  const [, setNow] = useState(Date.now()); // sert seulement à rafraîchir l'affichage chaque seconde
  const ref = useRef(t);
  ref.current = t;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const focus = (on, endAt) => {
    if (!Native || !prefsRef.current.timerFocus) return;
    try { Native.setFocusMode(on, endAt || 0); } catch {}
  };
  const buzz = () => { if (prefsRef.current.timerVibrate) Vibration.vibrate([0, 500, 250, 500, 250, 500]); };

  const nextPhase = (c, at) => {
    const p = prefsRef.current;
    if (c.phase === 'work') {
      if (c.cycle >= p.timerCycles) return { ...IDLE_TIMER, phase: 'done', cycle: c.cycle };
      return { ...c, phase: 'break', endAt: at + p.timerBreak * 60000, paused: false };
    }
    if (c.phase === 'break') return { ...c, phase: 'work', cycle: c.cycle + 1, endAt: at + p.timerWork * 60000, paused: false };
    return c;
  };
  const apply = (n) => {
    setT(n);
    if (n.phase === 'work') focus(true, n.endAt);
    else focus(false);
  };

  const start = () => apply({ ...IDLE_TIMER, phase: 'work', endAt: Date.now() + prefsRef.current.timerWork * 60000 });
  const stop = () => apply(IDLE_TIMER);
  const skip = () => { const c = ref.current; if (c.phase === 'work' || c.phase === 'break') { buzz(); apply(nextPhase(c, Date.now())); } };
  const pause = () => {
    const c = ref.current;
    if (c.paused || (c.phase !== 'work' && c.phase !== 'break')) return;
    setT({ ...c, paused: true, remaining: Math.max(0, c.endAt - Date.now()) });
    if (c.phase === 'work') focus(true, 0);
  };
  const resume = () => {
    const c = ref.current;
    if (!c.paused) return;
    const endAt = Date.now() + c.remaining;
    setT({ ...c, paused: false, endAt });
    if (c.phase === 'work') focus(true, endAt);
  };

  useEffect(() => {
    if ((t.phase !== 'work' && t.phase !== 'break') || t.paused) return undefined;
    const id = setInterval(() => {
      const nowMs = Date.now();
      setNow(nowMs);
      let c = ref.current;
      if (c.paused || c.endAt > nowMs) return;
      // si l'appli était en arrière-plan, plusieurs étapes ont pu s'écouler
      while ((c.phase === 'work' || c.phase === 'break') && c.endAt <= nowMs) c = nextPhase(c, c.endAt);
      buzz();
      apply(c);
    }, 1000);
    return () => clearInterval(id);
  }, [t.phase, t.paused, t.endAt]);

  const running = t.phase === 'work' || t.phase === 'break';
  const remaining = t.paused ? t.remaining : running ? Math.max(0, t.endAt - Date.now()) : prefs.timerWork * 60000;
  return { ...t, running, remaining, start, stop, skip, pause, resume, dismiss: () => setT(IDLE_TIMER) };
}

function Stepper({ label, value, unit, min, max, step = 1, onChange }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowText, { flex: 1 }]}>{label}</Text>
      <TouchableOpacity style={s.stepBtn} onPress={() => onChange(Math.max(min, value - step))}><Text style={s.stepTxt}>−</Text></TouchableOpacity>
      <Text style={s.stepVal}>{value}{unit ? ` ${unit}` : ''}</Text>
      <TouchableOpacity style={s.stepBtn} onPress={() => onChange(Math.min(max, value + step))}><Text style={s.stepTxt}>+</Text></TouchableOpacity>
    </View>
  );
}

function TimerPanel({ visible, onClose, timer, prefs, updatePref }) {
  const [access, setAccess] = useState(false);
  const check = useCallback(() => {
    if (!Native) return;
    try { setAccess(Native.hasFocusAccess()); } catch {}
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    check();
    const sub = AppState.addEventListener('change', (a) => { if (a === 'active') check(); });
    return () => sub.remove();
  }, [visible, check]);

  const phaseLabel = timer.phase === 'work' ? '🎯 Travail' : timer.phase === 'break' ? '☕ Pause' : timer.phase === 'done' ? '✓ Session terminée' : 'Prêt';
  const presets = [['25/5', 25, 5], ['50/10', 50, 10], ['90/15', 90, 15]];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.screen, { paddingTop: 44 }]}>
        <View style={s.btHeader}>
          <Text style={s.h1}>Minuteur de travail</Text>
          <TouchableOpacity onPress={onClose} style={s.btClose}><Text style={{ color: '#fff', fontSize: 18 }}>✕</Text></TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <View style={[s.btCard, s.center, { paddingVertical: 28 }]}>
            <Text style={[s.rowText, { opacity: 0.8 }]}>{phaseLabel}</Text>
            <Text style={s.timerBig}>{timer.phase === 'done' ? '00:00' : fmtTime(timer.remaining)}</Text>
            {timer.running && <Text style={s.hint}>Session {timer.cycle} sur {prefs.timerCycles}{timer.paused ? ' · en pause' : ''}</Text>}
            <View style={[s.chips, { justifyContent: 'center', marginTop: 16 }]}>
              {!timer.running ? (
                <TouchableOpacity style={[s.btn, { paddingHorizontal: 32 }]} onPress={timer.start}>
                  <Text style={s.btnText}>{timer.phase === 'done' ? 'Recommencer' : 'Démarrer'}</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity style={[s.btn, { paddingHorizontal: 22, marginRight: 8 }]} onPress={timer.paused ? timer.resume : timer.pause}>
                    <Text style={s.btnText}>{timer.paused ? 'Reprendre' : 'Pause'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.btnSecondary, { marginRight: 8 }]} onPress={timer.skip}>
                    <Text style={s.btnSecondaryText}>Passer ⏭</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btnSecondary} onPress={timer.stop}>
                    <Text style={s.btnSecondaryText}>Arrêter</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>

          <Text style={s.subTitle}>Durées</Text>
          <View style={s.chips}>
            {presets.map(([l, w, b]) => (
              <TouchableOpacity
                key={l}
                style={[s.chip, prefs.timerWork === w && prefs.timerBreak === b && s.chipOn]}
                onPress={() => { updatePref('timerWork', w); updatePref('timerBreak', b); }}
              >
                <Text style={[s.chipText, prefs.timerWork === w && prefs.timerBreak === b && s.chipTextOn]}>{l}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Stepper label="Travail" value={prefs.timerWork} unit="min" min={5} max={180} step={5} onChange={(v) => updatePref('timerWork', v)} />
          <Stepper label="Pause" value={prefs.timerBreak} unit="min" min={1} max={60} onChange={(v) => updatePref('timerBreak', v)} />
          <Stepper label="Nombre de sessions" value={prefs.timerCycles} min={1} max={12} onChange={(v) => updatePref('timerCycles', v)} />
          {timer.running && <Text style={s.hint}>Les changements s'appliquent à la prochaine étape.</Text>}

          <Text style={s.subTitle}>Pendant le travail</Text>
          <Toggle label="Vibrer à chaque changement" value={prefs.timerVibrate} onChange={(v) => updatePref('timerVibrate', v)} />
          {Native && (
            <>
              <Toggle
                label="Mode concentration sur le téléphone"
                hint="Active « Pochette – Travail » (Ne pas déranger) pendant le travail, le coupe pendant les pauses"
                value={prefs.timerFocus}
                disabled={!access}
                onChange={(v) => updatePref('timerFocus', v)}
              />
              {!access ? (
                <>
                  <Text style={s.hint}>Autorise d'abord Pochette à gérer le mode Ne pas déranger :</Text>
                  <ActionButton secondary label="Autoriser l'accès « Ne pas déranger »" onPress={() => Native.openFocusAccessSettings()} />
                </>
              ) : (
                <Text style={s.hint}>
                  Pour choisir qui peut quand même te joindre : Réglages du téléphone → Modes (ou Ne pas déranger) → « Pochette – Travail ».
                  Il apparaît après la première session.
                </Text>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ---------- Application ----------
export default function App() {
  useKeepAwake(); // l'écran reste allumé tant que l'app est ouverte
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const [stage, setStage] = useState('loading'); // loading | setup | login | ready
  const [clientInput, setClientInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState(null);
  const [offline, setOffline] = useState(false);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('display');
  const [btOpen, setBtOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [lyrics, setLyrics] = useState(null);
  const lyricsCache = useRef({});
  const [uiVisible, setUiVisible] = useState(true);
  const [aod, setAod] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');
  const [native, setNative] = useState({ access: false, settings: null, nowPlaying: null });

  const auth = useRef({ clientId: null, access: null, expiresAt: 0, refresh: null });
  const progress = useRef(new Animated.Value(0)).current;
  const shift = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const hideTimer = useRef(null);

  // ----- Chargement initial -----
  useEffect(() => {
    (async () => {
      const a = auth.current;
      a.clientId = await sget('clientId');
      a.refresh = await sget('refreshToken');
      a.access = await sget('accessToken');
      a.expiresAt = Number((await sget('expiresAt')) || 0);
      try {
        const p = await sget('prefs');
        if (p) setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(p) });
      } catch {}
      setStage(!a.clientId ? 'setup' : !a.refresh ? 'login' : 'ready');
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => setAppActive(st === 'active'));
    return () => sub.remove();
  }, []);

  // ----- Fonctions Android (fond d'écran, widgets, économiseur) -----
  const refreshNative = useCallback(() => {
    if (!Native) return;
    try {
      setNative({
        access: Native.hasNotificationAccess(),
        settings: Native.getSettings(),
        nowPlaying: Native.getNowPlaying(),
      });
    } catch {}
  }, []);

  // Au retour des réglages Android, on revérifie l'autorisation
  useEffect(() => { if (appActive) refreshNative(); }, [appActive, refreshNative]);
  useEffect(() => { if (settingsOpen) refreshNative(); }, [settingsOpen, refreshNative]);

  function setNativeSetting(values) {
    if (!Native) return;
    try {
      const next = Native.setSettings(values);
      setNative((n) => ({ ...n, settings: next }));
    } catch {}
  }

  async function applyWallpaperNow() {
    if (!Native) return;
    const ok = await Native.applyWallpaperNow();
    if (!ok) Alert.alert('Fond d\'écran', 'Aucune pochette détectée pour l\'instant. Lance un morceau puis réessaie.');
  }

  function addWidget(kind) {
    if (!Native) return;
    let ok = false;
    try { ok = Native.requestPinWidget(kind); } catch {}
    if (!ok) {
      Alert.alert('Ajouter un widget', 'Fais un appui long sur l\'écran d\'accueil, touche « Widgets » puis cherche « Pochette ».');
    }
  }

  function updatePref(key, value) {
    setPrefs((p) => {
      const next = { ...p, [key]: value };
      sset('prefs', JSON.stringify(next));
      return next;
    });
  }

  // ----- Jetons Spotify -----
  async function saveTokens(d) {
    const a = auth.current;
    a.access = d.access_token;
    a.expiresAt = Date.now() + (d.expires_in - 60) * 1000;
    await sset('accessToken', a.access);
    await sset('expiresAt', a.expiresAt);
    if (d.refresh_token) { a.refresh = d.refresh_token; await sset('refreshToken', a.refresh); }
  }
  async function clearTokens() {
    const a = auth.current;
    a.access = null; a.refresh = null; a.expiresAt = 0;
    await sdel('accessToken'); await sdel('refreshToken'); await sdel('expiresAt');
  }
  async function getAccessToken() {
    const a = auth.current;
    if (a.access && Date.now() < a.expiresAt) return a.access;
    const d = await tokenRequest(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh });
    await saveTokens(d);
    return a.access;
  }

  // ----- Interrogation de Spotify, calée sur la fin du morceau -----
  useEffect(() => {
    if (stage !== 'ready' || !appActive) return undefined;
    let stop = false;
    let timer;
    let failures = 0;
    const loop = async () => {
      let delay = POLL_IDLE_MS;
      try {
        const token = await getAccessToken();
        const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${token}` } });
        failures = 0;
        if (!stop) setOffline(false);
        if (res.status === 204) {
          if (!stop) setTrack(null);
        } else if (res.status === 200) {
          const t = normalize(await res.json());
          if (!stop) setTrack(t);
          if (t && t.isPlaying && t.durationMs) {
            const left = t.durationMs - t.progressMs;
            delay = Math.max(1000, Math.min(POLL_PLAYING_MS, left + 700));
          }
        } else if (res.status === 401) {
          auth.current.access = null;
          delay = 500;
        } else if (res.status === 429) {
          delay = (parseInt(res.headers.get('retry-after') || '5', 10) + 1) * 1000;
        }
      } catch (e) {
        if (e && (e.status === 400 || e.status === 401)) {
          await clearTokens();
          if (!stop) { setTrack(null); setStage('login'); }
          return;
        }
        failures += 1;
        if (failures >= 3 && !stop) setOffline(true);
      }
      if (!stop) timer = setTimeout(loop, delay);
    };
    loop();
    return () => { stop = true; clearTimeout(timer); };
  }, [stage, appActive]);

  // ----- Minuteur -----
  const timer = useWorkTimer(prefs);

  // ----- Paroles : chargées à chaque nouveau morceau quand l'option est active -----
  const trackKey = track ? `${track.id}` : null;
  useEffect(() => {
    if (!prefs.showLyrics || !track) { setLyrics(null); return undefined; }
    const key = trackKey;
    if (lyricsCache.current[key]) { setLyrics(lyricsCache.current[key]); return undefined; }
    let cancelled = false;
    setLyrics({ status: 'loading' });
    fetchLyrics(track)
      .then((r) => { lyricsCache.current[key] = r; if (!cancelled) setLyrics(r); })
      .catch(() => { if (!cancelled) setLyrics({ status: 'error' }); });
    return () => { cancelled = true; };
  }, [trackKey, prefs.showLyrics]);

  // ----- Barre de progression -----
  useEffect(() => {
    progress.stopAnimation();
    if (!track || !track.durationMs) { progress.setValue(0); return; }
    progress.setValue(Math.min(1, track.progressMs / track.durationMs));
    if (track.isPlaying) {
      Animated.timing(progress, {
        toValue: 1,
        duration: Math.max(0, track.durationMs - track.progressMs),
        easing: Easing.linear,
        useNativeDriver: false,
      }).start();
    }
  }, [track]);

  // ----- Anti-marquage : déplacement lent (plus ample en mode Always-On) -----
  useEffect(() => {
    const enabled = stage === 'ready' && appActive && (aod || prefs.antiBurnIn);
    if (!enabled) {
      Animated.timing(shift, { toValue: { x: 0, y: 0 }, duration: 800, useNativeDriver: true }).start();
      return undefined;
    }
    const amp = aod ? Math.min(width, height) * 0.12 : 10;
    const every = aod ? 60000 : 120000;
    const rand = () => Math.round((Math.random() * 2 - 1) * amp);
    const id = setInterval(() => {
      Animated.timing(shift, {
        toValue: { x: rand(), y: rand() }, duration: 4000, easing: Easing.inOut(Easing.ease), useNativeDriver: true,
      }).start();
    }, every);
    return () => clearInterval(id);
  }, [stage, prefs.antiBurnIn, appActive, aod, width, height]);

  // ----- Bouton ⚙ qui s'efface -----
  const pokeUi = useCallback(() => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setUiVisible(false), UI_HIDE_MS);
  }, []);
  useEffect(() => {
    if (stage === 'ready') pokeUi();
    return () => clearTimeout(hideTimer.current);
  }, [stage, pokeUi]);

  // ----- Mode Always-On -----
  function enterAod() {
    setSettingsOpen(false);
    setAod(true);
    if (Native) Native.setAodWindow(true).catch(() => {});
  }
  const exitAod = useCallback(() => {
    setAod(false);
    if (Native) Native.setAodWindow(false).catch(() => {});
    pokeUi();
  }, [pokeUi]);
  useEffect(() => {
    if (!aod) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { exitAod(); return true; });
    return () => sub.remove();
  }, [aod, exitAod]);

  // ----- Actions de compte -----
  async function saveClientId() {
    const id = clientInput.trim();
    if (!id) return;
    await sset('clientId', id);
    auth.current.clientId = id;
    await clearTokens();
    setStage('login');
  }

  async function login() {
    setError(''); setBusy(true);
    try {
      const a = auth.current;
      const request = new AuthSession.AuthRequest({
        clientId: a.clientId,
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
        usePKCE: true,
        responseType: AuthSession.ResponseType.Code,
      });
      await request.makeAuthUrlAsync(DISCOVERY);
      const result = await request.promptAsync(DISCOVERY);
      if (result.type === 'success' && result.params && result.params.code) {
        const d = await tokenRequest(a.clientId, {
          grant_type: 'authorization_code',
          code: result.params.code,
          redirect_uri: REDIRECT_URI,
          code_verifier: request.codeVerifier,
        });
        await saveTokens(d);
        setStage('ready');
      } else if (result.type !== 'dismiss' && result.type !== 'cancel') {
        setError('Connexion refusée. Réessaie.');
      }
    } catch (e) {
      setError('Échec de la connexion. Vérifie le Client ID et la Redirect URI dans le dashboard Spotify.');
    }
    setBusy(false);
  }

  async function changeClientId() {
    setSettingsOpen(false);
    await sdel('clientId'); await clearTokens();
    auth.current.clientId = null; setTrack(null); setClientInput(''); setStage('setup');
  }
  async function logout() {
    setSettingsOpen(false);
    await clearTokens(); setTrack(null); setStage('login');
  }

  // ---------- Panneau de réglages ----------
  function renderSettings() {
    const ns = native.settings || {};
    const ready = stage === 'ready';
    const np = native.nowPlaying;
    const tabs = [
      ...(ready ? [['display', 'Affichage'], ['clock', 'Horloge'], ['screen', 'Écran']] : []),
      ...(Native ? [['phone', 'Téléphone'], ['bt', 'Bluetooth']] : []),
      ['account', 'Compte'],
    ];
    const tab = tabs.some(([k]) => k === settingsTab) ? settingsTab : tabs[0][0];
    const close = () => setSettingsOpen(false);

    return (
      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={close} statusBarTranslucent>
        <View style={[s.backdrop, s.center]}>
          {/* Le fond capte le toucher pour fermer ; la carte, elle, laisse défiler */}
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
          <View style={[s.card, s.settingsCard]}>
            <Text style={s.h1}>Réglages</Text>
            <View style={s.tabs}>
              {tabs.map(([k, l]) => (
                <TouchableOpacity key={k} onPress={() => setSettingsTab(k)} style={[s.tab, tab === k && s.tabOn]}>
                  <Text style={[s.tabText, tab === k && s.tabTextOn]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 12 }} keyboardShouldPersistTaps="handled">
              {tab === 'display' && (
                <>
                  <Choice
                    label="Style de la pochette"
                    value={prefs.coverStyle}
                    onChange={(v) => updatePref('coverStyle', v)}
                    options={[['cover', 'Pochette'], ['vinyl', 'Vinyle qui tourne'], ['sleeve', 'Pochette + vinyle']]}
                  />
                  <Choice
                    label="Vitesse du vinyle"
                    value={prefs.vinylSpeed}
                    disabled={prefs.coverStyle === 'cover'}
                    onChange={(v) => updatePref('vinylSpeed', v)}
                    options={[['33', '33 tours'], ['45', '45 tours']]}
                  />
                  <Toggle label="Titre et artiste" value={prefs.showInfo} onChange={(v) => updatePref('showInfo', v)} />
                  <Toggle label="Barre de progression" value={prefs.showProgress} onChange={(v) => updatePref('showProgress', v)} />
                  <Choice
                    label="Style de la barre"
                    value={prefs.progressStyle}
                    disabled={!prefs.showProgress}
                    onChange={(v) => updatePref('progressStyle', v)}
                    options={[['wave', 'Vagues'], ['line', 'Ligne droite']]}
                  />
                  <Choice
                    label="Fond"
                    value={prefs.bgStyle}
                    onChange={(v) => updatePref('bgStyle', v)}
                    options={[['blur', 'Flou'], ['black', 'Noir'], ['cover', 'Pochette en grand']]}
                  />
                  <Choice
                    label="Coins de la pochette"
                    value={prefs.corners}
                    onChange={(v) => updatePref('corners', v)}
                    options={[['round', 'Arrondis'], ['square', 'Carrés']]}
                  />
                  <ColorRow label="Couleur de la barre de progression" value={prefs.accent} onChange={(c) => updatePref('accent', c)} />
                </>
              )}

              {tab === 'clock' && (
                <>
                  <View style={s.preview}>
                    <Clock p={prefs} scale={Math.min(1, 220 / ((CLOCK_SIZES[prefs.clockSize] || 48) * 4))} />
                  </View>
                  <Toggle label="Afficher l'horloge" value={prefs.showClock} onChange={(v) => updatePref('showClock', v)} />
                  <Choice
                    label="Type d'horloge"
                    value={prefs.clockType}
                    onChange={(v) => updatePref('clockType', v)}
                    options={[['classic', 'Classique'], ['flip', 'Basculante (palettes)']]}
                  />
                  <Choice
                    label="Position"
                    value={prefs.clockPosition}
                    onChange={(v) => updatePref('clockPosition', v)}
                    options={[['info', 'Avec le titre'], ['top', 'En haut de l\'écran']]}
                  />
                  <Choice
                    label="Taille"
                    value={prefs.clockSize}
                    onChange={(v) => updatePref('clockSize', v)}
                    options={[['S', 'Petite'], ['M', 'Moyenne'], ['L', 'Grande'], ['XL', 'Très grande']]}
                  />
                  <Choice
                    label="Épaisseur"
                    value={prefs.clockWeight}
                    onChange={(v) => updatePref('clockWeight', v)}
                    options={[['thin', 'Fine'], ['regular', 'Normale'], ['bold', 'Grasse']]}
                  />
                  <Choice
                    label="Police"
                    value={prefs.clockFont}
                    onChange={(v) => updatePref('clockFont', v)}
                    options={[['default', 'Standard'], ['condensed', 'Étroite'], ['serif', 'Classique'], ['mono', 'Machine à écrire']]}
                  />
                  <ColorRow label="Couleur" value={prefs.clockColor} onChange={(c) => updatePref('clockColor', c)} />
                  <Toggle label="Secondes" value={prefs.clockSeconds} onChange={(v) => updatePref('clockSeconds', v)} />
                  <Toggle label="Date" value={prefs.clockDate} onChange={(v) => updatePref('clockDate', v)} />
                  <Toggle label="Format 12 h (AM/PM)" value={prefs.clock12h} onChange={(v) => updatePref('clock12h', v)} />
                  <Text style={s.hint}>Le mode Always-On utilise aussi cette horloge.</Text>
                </>
              )}

              {tab === 'screen' && (
                <>
                  <Toggle label="Mode nuit" hint="Assombrit tout l'affichage" value={prefs.nightMode} onChange={(v) => updatePref('nightMode', v)} />
                  <Toggle label="Protection anti-marquage" hint="Décale l'image de quelques pixels" value={prefs.antiBurnIn} onChange={(v) => updatePref('antiBurnIn', v)} />
                  <ActionButton label="Lancer le mode Always-On" onPress={enterAod} />
                  <Text style={[s.hint, { marginTop: 8 }]}>Écran noir, horloge et pochette, luminosité minimale. Touche l'écran pour quitter.</Text>
                </>
              )}

              {tab === 'phone' && Native && (
                <>
                  {!native.access ? (
                    <>
                      <Text style={s.p}>
                        Première étape : autoriser Pochette à suivre ta musique même quand l'appli est fermée
                        (« accès aux notifications »). Pochette ne lit pas tes notifications, elle s'en sert seulement
                        pour connaître le morceau en cours.
                      </Text>
                      <ActionButton label="Autoriser l'accès" onPress={() => Native.openNotificationAccessSettings()} />
                      <Text style={[s.hint, { marginTop: 10 }]}>
                        Si l'interrupteur est grisé : « Infos de l'appli », touche ⋮ en haut à droite puis
                        « Autoriser les paramètres restreints », et réessaie.
                      </Text>
                      <ActionButton secondary label="Infos de l'appli" onPress={() => Native.openAppDetails()} />
                    </>
                  ) : (
                    <Text style={[s.hint, { marginBottom: 6 }]}>
                      {np ? `✓ Détecté : ${np.title}${np.artist ? ` — ${np.artist}` : ''}` : '✓ Accès activé. Lance un morceau pour le voir apparaître ici.'}
                    </Text>
                  )}

                  <Text style={s.subTitle}>Fond d'écran en direct</Text>
                  <Toggle
                    label="Activer"
                    hint="Ton fond d'écran prend la pochette de chaque nouveau morceau"
                    value={ns.wallpaperEnabled}
                    disabled={!native.access}
                    onChange={(v) => setNativeSetting({ wallpaperEnabled: v })}
                  />
                  <Choice
                    label="Où"
                    value={ns.wallpaperTarget}
                    disabled={!native.access || !ns.wallpaperEnabled}
                    onChange={(v) => setNativeSetting({ wallpaperTarget: v })}
                    options={[['lock', 'Verrouillage'], ['home', 'Accueil'], ['both', 'Les deux']]}
                  />
                  <Choice
                    label="Style"
                    value={ns.wallpaperStyle}
                    disabled={!native.access || !ns.wallpaperEnabled}
                    onChange={(v) => setNativeSetting({ wallpaperStyle: v })}
                    options={[['blur', 'Pochette sur fond flou'], ['vinyl', 'Vinyle'], ['fill', 'Plein écran']]}
                  />
                  <ActionButton secondary label="Appliquer maintenant" disabled={!native.access || !ns.wallpaperEnabled} onPress={applyWallpaperNow} />

                  <Text style={s.subTitle}>Musique suivie</Text>
                  <Choice
                    label="Source"
                    value={ns.source}
                    disabled={!native.access}
                    onChange={(v) => setNativeSetting({ source: v })}
                    options={[['spotify', 'Spotify'], ['all', 'Toutes les applis']]}
                  />

                  <Text style={s.subTitle}>Widgets</Text>
                  <ActionButton secondary label="Ajouter « Pochette » (carré)" onPress={() => addWidget('cover')} />
                  <ActionButton secondary label="Ajouter « Vinyle » (carré)" onPress={() => addWidget('vinyl')} />
                  <ActionButton secondary label="Ajouter « Lecture en cours » (avec boutons)" onPress={() => addWidget('nowplaying')} />
                  <Text style={[s.hint, { marginTop: 8 }]}>
                    Les widgets se mettent à jour à chaque changement de morceau, même appli fermée, une fois l'accès autorisé.
                    Android ne permet pas d'animer un widget : le vinyle y est donc immobile.
                  </Text>

                  <Text style={s.subTitle}>Économiseur d'écran</Text>
                  <Text style={s.hint}>
                    Horloge et pochette sur fond noir pendant que le téléphone charge, même appli fermée.
                    Choisis « Pochette » dans les réglages qui vont s'ouvrir.
                  </Text>
                  <Choice
                    label="Style de l'économiseur"
                    value={ns.dreamStyle}
                    onChange={(v) => setNativeSetting({ dreamStyle: v })}
                    options={[['cover', 'Pochette'], ['vinyl', 'Vinyle qui tourne']]}
                  />
                  <ActionButton secondary label="Ouvrir les réglages de l'économiseur" onPress={() => Native.openScreenSaverSettings()} />
                </>
              )}

              {tab === 'bt' && (
                <>
                  <Text style={s.p}>Connecte tes enceintes et choisis où jouer la musique, sur une ou deux enceintes à la fois.</Text>
                  <ActionButton label="Ouvrir Bluetooth & enceintes" onPress={() => { setSettingsOpen(false); setBtOpen(true); }} />
                  <Text style={[s.hint, { marginTop: 8 }]}>Raccourci : le bouton 🔊 à côté de ⚙ sur l'écran principal.</Text>
                </>
              )}

              {tab === 'account' && (
                <>
                  <ActionButton secondary label="Changer le Client ID" onPress={changeClientId} />
                  {stage !== 'setup' && <ActionButton secondary label="Se déconnecter" onPress={logout} />}
                </>
              )}
            </ScrollView>

            <ActionButton label="Fermer" onPress={close} />
            <Text style={[s.hint, { textAlign: 'center', marginTop: 10 }]}>Pochette version {APP_VERSION}</Text>
          </View>
        </View>
      </Modal>
    );
  }

  // ---------- Écrans ----------
  if (stage === 'loading') {
    return (
      <View style={[s.screen, s.center]}>
        <StatusBar style="light" />
        <ActivityIndicator color="#1db954" />
      </View>
    );
  }

  if (stage === 'setup') {
    return (
      <View style={[s.screen, s.center, { padding: 24 }]}>
        <StatusBar style="light" />
        <View style={s.card}>
          <Text style={s.h1}>Configuration Spotify</Text>
          <Text style={s.p}>1. Va sur developer.spotify.com/dashboard et crée une app (« Web API »).</Text>
          <Text style={s.p}>2. Dans « Redirect URI », ajoute exactement :</Text>
          <Text selectable style={s.code}>{REDIRECT_URI}</Text>
          <Text style={s.p}>3. Copie le Client ID et colle-le ici :</Text>
          <TextInput
            style={s.input}
            value={clientInput}
            onChangeText={setClientInput}
            placeholder="Client ID"
            placeholderTextColor="#888"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={saveClientId}
          />
          <TouchableOpacity style={[s.btn, !clientInput.trim() && { opacity: 0.5 }]} onPress={saveClientId} disabled={!clientInput.trim()}>
            <Text style={s.btnText}>Enregistrer et continuer</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (stage === 'login') {
    return (
      <View style={[s.screen, s.center, { padding: 24 }]}>
        <StatusBar style="light" />
        <View style={s.card}>
          <Text style={s.h1}>Connexion à Spotify</Text>
          <Text style={s.p}>
            Tu vas être redirigé vers Spotify pour autoriser l'accès (lecture seule du morceau en cours), puis tu reviendras ici.
          </Text>
          <TouchableOpacity style={[s.btn, busy && { opacity: 0.5 }]} onPress={login} disabled={busy}>
            {busy ? <ActivityIndicator color="#000" /> : <Text style={s.btnText}>Se connecter avec Spotify</Text>}
          </TouchableOpacity>
          {!!error && <Text style={s.err}>{error}</Text>}
          <TouchableOpacity onPress={() => setSettingsOpen(true)} style={{ marginTop: 16 }}>
            <Text style={[s.p, { textAlign: 'center', opacity: 0.6 }]}>Réglages</Text>
          </TouchableOpacity>
        </View>
        {renderSettings()}
      </View>
    );
  }

  // ----- Mode Always-On -----
  if (aod) {
    const small = Math.min(width, height) * 0.38;
    return (
      <Pressable style={[s.screen, s.center]} onPress={exitAod}>
        <StatusBar hidden />
        <Animated.View style={[s.center, { transform: shift.getTranslateTransform() }]} pointerEvents="none">
          <View style={{ opacity: 0.8 }}><Clock p={prefs} scale={1.4} /></View>
          {timer.running && (
            <Text style={[s.aodText, { marginTop: 4 }]}>
              {timer.phase === 'work' ? '🎯 Travail' : '☕ Pause'} · {fmtTime(timer.remaining)}
            </Text>
          )}
          {track && prefs.coverStyle !== 'cover' ? (
            <View style={{ marginTop: 20, opacity: 0.85 }}>
              <Vinyl uri={track.image} size={small} playing={track.isPlaying} speed={prefs.vinylSpeed} />
            </View>
          ) : track && track.image ? (
            <Image
              source={{ uri: track.image }}
              style={{ width: small, height: small, marginTop: 20, opacity: 0.8, borderRadius: prefs.corners === 'round' ? 10 : 0 }}
            />
          ) : null}
          {track ? (
            <>
              <Text numberOfLines={1} style={[s.aodText, { marginTop: 16, maxWidth: small * 1.6 }]}>{track.title}</Text>
              <Text numberOfLines={1} style={[s.aodText, { opacity: 0.6, fontSize: 14, maxWidth: small * 1.6 }]}>{track.artist}</Text>
            </>
          ) : null}
        </Animated.View>
      </Pressable>
    );
  }

  // ----- Écran principal -----
  const radius = prefs.corners === 'round' ? 10 : 0;
  const immersive = prefs.bgStyle === 'cover';
  const clockWithInfo = prefs.showClock && prefs.clockPosition !== 'top';
  const clockOnTop = prefs.showClock && prefs.clockPosition === 'top';
  const lyricsOn = prefs.showLyrics && !!track;
  const compact = prefs.showInfo || prefs.showProgress || clockWithInfo || lyricsOn;
  const coverSize = lyricsOn
    ? (landscape ? Math.min(height * 0.7, width * 0.38) : Math.min(width * 0.62, height * 0.32))
    : landscape
    ? (compact ? Math.min(height * 0.8, width * 0.45) : Math.min(height * 0.88, width * 0.9))
    : (compact ? Math.min(width * 0.88, height * 0.55) : Math.min(width * 0.92, height * 0.8));
  const barWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const textAlign = immersive || landscape ? 'left' : 'center';

  const infoBlock = track && compact ? (
    <>
      {clockWithInfo && !lyricsOn && <Clock p={prefs} align={textAlign} />}
      {prefs.showInfo && (
        <>
          <Text numberOfLines={1} style={[s.title, { textAlign }]}>{track.title}</Text>
          <Text numberOfLines={1} style={[s.sub, { textAlign }]}>
            {[track.artist, track.album].filter(Boolean).join(' — ')}
          </Text>
        </>
      )}
      {lyricsOn && <LyricsView lyrics={lyrics} track={track} align={textAlign} />}
      {prefs.showProgress && !lyricsOn && track.durationMs ? (
        prefs.progressStyle === 'wave' ? (
          <WaveProgress progress={progress} playing={track.isPlaying} color={prefs.accent} />
        ) : (
          <View style={s.barTrack}>
            <Animated.View style={[s.barFill, { width: barWidth, backgroundColor: prefs.accent }]} />
          </View>
        )
      ) : null}
    </>
  ) : null;

  return (
    <Pressable style={s.screen} onPress={pokeUi}>
      <StatusBar hidden />

      {track && track.image && prefs.bgStyle !== 'black' ? (
        <>
          <CrossfadeImage uri={track.image} blurRadius={immersive ? 0 : 30} style={StyleSheet.absoluteFill} />
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: immersive ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.6)' }]}
          />
        </>
      ) : null}

      <Animated.View style={{ flex: 1, transform: shift.getTranslateTransform() }} pointerEvents="none">
        {track && clockOnTop && (
          <View style={s.topClock}><Clock p={prefs} /></View>
        )}
        {!track ? (
          <View style={[s.center, { flex: 1, padding: 24 }]}>
            {prefs.showClock && <View style={{ marginBottom: 16 }}><Clock p={prefs} /></View>}
            <Text style={{ fontSize: 56, marginBottom: 12 }}>🎵</Text>
            <Text style={[s.title, { textAlign: 'center' }]}>Lance ta musique sur Spotify</Text>
            <Text style={[s.sub, { marginTop: 6, textAlign: 'center' }]}>La pochette s'affichera ici automatiquement.</Text>
          </View>
        ) : immersive ? (
          // Pochette en grand : la pochette occupe tout l'écran, infos en bas
          <View style={{ flex: 1, justifyContent: 'flex-end', padding: 24, paddingBottom: 40 }}>
            {!track.isPlaying && (
              <View style={[StyleSheet.absoluteFill, s.center]}>
                <Text style={s.pauseIcon}>❚❚</Text>
              </View>
            )}
            {compact && <View style={s.immersivePanel}>{infoBlock}</View>}
          </View>
        ) : (
          <View style={[s.center, { flex: 1, flexDirection: landscape ? 'row' : 'column', padding: 20, paddingTop: clockOnTop ? 40 + (CLOCK_SIZES[prefs.clockSize] || 48) * 1.6 : 20 }]}>
            {prefs.coverStyle === 'vinyl' ? (
              <Vinyl uri={track.image} size={coverSize} playing={track.isPlaying} speed={prefs.vinylSpeed} />
            ) : prefs.coverStyle === 'sleeve' ? (
              <Sleeve uri={track.image} width={coverSize} playing={track.isPlaying} speed={prefs.vinylSpeed} radius={radius} />
            ) : (
            <View style={[s.coverWrap, { width: coverSize, height: coverSize, borderRadius: radius }]}>
              {track.image ? (
                <CrossfadeImage uri={track.image} style={{ width: coverSize, height: coverSize, borderRadius: radius }} />
              ) : (
                <View style={[s.center, { flex: 1 }]}><Text style={{ fontSize: coverSize / 4 }}>🎵</Text></View>
              )}
              {!track.isPlaying && (
                <View style={[s.pausedOverlay, s.center, { borderRadius: radius }]}>
                  <Text style={s.pauseIcon}>❚❚</Text>
                </View>
              )}
            </View>
            )}
            {compact && (
              <View
                style={{
                  marginTop: landscape ? 0 : 24,
                  marginLeft: landscape ? 28 : 0,
                  flex: landscape ? 1 : 0,
                  width: landscape ? undefined : coverSize,
                  maxWidth: 520,
                }}
              >
                {infoBlock}
              </View>
            )}
          </View>
        )}
      </Animated.View>

      {prefs.nightMode && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]} />
      )}

      {offline && (
        <View pointerEvents="none" style={s.offline}>
          <Text style={s.offlineText}>Connexion perdue — nouvelle tentative…</Text>
        </View>
      )}

      {uiVisible && (
        <TouchableOpacity style={s.gear} onPress={() => setSettingsOpen(true)}>
          <Text style={{ color: '#fff', fontSize: 18 }}>⚙</Text>
        </TouchableOpacity>
      )}
      {uiVisible && Native && (
        <TouchableOpacity style={[s.gear, { right: 68 }]} onPress={() => setBtOpen(true)}>
          <Text style={{ color: '#fff', fontSize: 17 }}>🔊</Text>
        </TouchableOpacity>
      )}
      {uiVisible && (
        <TouchableOpacity
          style={[s.gear, { right: Native ? 120 : 68 }, prefs.showLyrics && { backgroundColor: 'rgba(29,185,84,0.45)', opacity: 1 }]}
          onPress={() => updatePref('showLyrics', !prefs.showLyrics)}
        >
          <Text style={{ color: '#fff', fontSize: 17 }}>🎤</Text>
        </TouchableOpacity>
      )}
      {uiVisible && (
        <TouchableOpacity style={[s.gear, { right: Native ? 172 : 120 }]} onPress={() => setTimerOpen(true)}>
          <Text style={{ color: '#fff', fontSize: 17 }}>⏱</Text>
        </TouchableOpacity>
      )}

      {(timer.running || timer.phase === 'done') && (
        <TouchableOpacity
          style={[s.timerBadge, timer.phase === 'break' && { backgroundColor: 'rgba(77,163,255,0.35)' }, timer.phase === 'done' && { backgroundColor: 'rgba(29,185,84,0.45)' }]}
          onPress={() => (timer.phase === 'done' ? timer.dismiss() : setTimerOpen(true))}
        >
          <Text style={s.timerBadgeText}>
            {timer.phase === 'done' ? '✓ Session terminée' : `${timer.phase === 'work' ? '🎯 Travail' : '☕ Pause'} · ${fmtTime(timer.remaining)}${timer.paused ? ' ⏸' : ''}`}
          </Text>
        </TouchableOpacity>
      )}

      {renderSettings()}
      <BluetoothPanel visible={btOpen} onClose={() => setBtOpen(false)} />
      <TimerPanel visible={timerOpen} onClose={() => setTimerOpen(false)} timer={timer} prefs={prefs} updatePref={updatePref} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 480, backgroundColor: '#1c1c1c', borderRadius: 18, padding: 22 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', padding: 20 },
  h1: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  p: { color: '#fff', opacity: 0.9, fontSize: 14, lineHeight: 21, marginBottom: 10 },
  hint: { color: '#fff', opacity: 0.55, fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  code: {
    color: '#fff', backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 8, paddingVertical: 6,
    borderRadius: 6, fontSize: 13, alignSelf: 'flex-start', marginBottom: 12,
  },
  input: {
    color: '#fff', backgroundColor: 'rgba(0,0,0,0.45)', borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1,
    borderRadius: 10, padding: 14, fontSize: 16, marginBottom: 12,
  },
  btn: { backgroundColor: '#1db954', borderRadius: 999, paddingVertical: 13, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  btnText: { color: '#000', fontWeight: '700', fontSize: 15 },
  btnSecondary: {
    borderRadius: 999, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  btnSecondaryText: { color: '#fff', fontSize: 14, textAlign: 'center' },
  lyricNow: { color: '#fff', fontSize: 21, fontWeight: '700', marginVertical: 4 },
  lyricDim: { color: '#fff', fontSize: 16, marginVertical: 3 },
  timerBig: { color: '#fff', fontSize: 72, fontWeight: '200', fontVariant: ['tabular-nums'], marginVertical: 6 },
  timerBadge: {
    position: 'absolute', top: 38, left: 16, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    backgroundColor: 'rgba(255,92,138,0.35)',
  },
  timerBadgeText: { color: '#fff', fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  stepTxt: { color: '#fff', fontSize: 20 },
  stepVal: { color: '#fff', fontSize: 16, minWidth: 74, textAlign: 'center', fontVariant: ['tabular-nums'] },
  btHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  btClose: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  btCard: { backgroundColor: '#161616', borderRadius: 16, padding: 18, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  btBig: { color: '#fff', fontSize: 18, fontWeight: '700' },
  btRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  btIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' },
  btName: { color: '#fff', fontSize: 16 },
  btStatus: { color: '#fff', opacity: 0.55, fontSize: 13, marginTop: 2 },
  btAction: { color: '#1db954', fontWeight: '700', fontSize: 14 },
  settingsCard: { maxHeight: '92%', paddingBottom: 16 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 },
  tab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, marginRight: 6, marginBottom: 6 },
  tabOn: { backgroundColor: '#1db954' },
  tabText: { color: '#fff', opacity: 0.75, fontSize: 14 },
  tabTextOn: { color: '#000', opacity: 1, fontWeight: '700' },
  subTitle: { color: '#1db954', fontSize: 13, fontWeight: '700', letterSpacing: 0.5, marginTop: 20, marginBottom: 2, textTransform: 'uppercase' },
  preview: { backgroundColor: '#000', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 8 },
  topClock: { position: 'absolute', top: 36, left: 0, right: 0, alignItems: 'center' },
  section: { marginTop: 18, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.15)' },
  sectionTitle: { color: '#1db954', fontSize: 13, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  rowText: { color: '#fff', fontSize: 15 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, marginRight: 8, marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  chipOn: { backgroundColor: '#fff', borderColor: '#fff' },
  chipText: { color: '#fff', fontSize: 13 },
  chipTextOn: { color: '#000', fontWeight: '700' },
  swatch: { width: 32, height: 32, borderRadius: 16, marginRight: 12, marginBottom: 8, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: '#fff', transform: [{ scale: 1.15 }] },
  err: { color: '#ff9a9a', fontSize: 13, marginTop: 12 },
  coverWrap: { backgroundColor: '#111', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 20, elevation: 16 },
  pausedOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  pauseIcon: { color: '#fff', fontSize: 42, opacity: 0.85, letterSpacing: -4 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  sub: { color: '#fff', opacity: 0.7, fontSize: 16, marginTop: 4 },
  clock: { color: '#fff', fontSize: 44, fontWeight: '200', marginBottom: 8 },
  immersivePanel: { backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 16, padding: 18 },
  barTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)', marginTop: 16, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 },
  aodClock: { color: '#bdbdbd', fontSize: 72, fontWeight: '200' },
  aodText: { color: '#a0a0a0', fontSize: 16, textAlign: 'center' },
  offline: {
    position: 'absolute', bottom: 24, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
  },
  offlineText: { color: '#fff', opacity: 0.85, fontSize: 13 },
  gear: {
    position: 'absolute', top: 36, right: 16, width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', opacity: 0.6,
  },
});
