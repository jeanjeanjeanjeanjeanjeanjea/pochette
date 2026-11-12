import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, ActivityIndicator, Animated, Easing,
  StyleSheet, useWindowDimensions, AppState, Modal, Switch, Pressable, ScrollView, Alert, BackHandler,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';
import Native from './modules/pochette-native';

WebBrowser.maybeCompleteAuthSession();

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
  showClock: false,
  bgStyle: 'blur',     // blur | black | cover
  corners: 'round',    // round | square
  accent: '#ffffff',
  nightMode: false,
  antiBurnIn: true,
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

function Clock({ style }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    let t;
    const schedule = () => {
      t = setTimeout(() => { setNow(new Date()); schedule(); }, 60000 - (Date.now() % 60000) + 50);
    };
    schedule();
    return () => clearTimeout(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return <Text style={style}>{hh}:{mm}</Text>;
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
    return (
      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)} statusBarTranslucent>
        <Pressable style={[s.backdrop, s.center]} onPress={() => setSettingsOpen(false)}>
          <Pressable style={[s.card, { maxHeight: '92%', padding: 0 }]} onPress={() => {}}>
            <ScrollView contentContainerStyle={{ padding: 22 }}>
              <Text style={s.h1}>Réglages</Text>

              {ready && (
                <>
                  <Section title="Affichage">
                    <Toggle label="Titre et artiste" value={prefs.showInfo} onChange={(v) => updatePref('showInfo', v)} />
                    <Toggle label="Barre de progression" value={prefs.showProgress} onChange={(v) => updatePref('showProgress', v)} />
                    <Toggle label="Horloge" value={prefs.showClock} onChange={(v) => updatePref('showClock', v)} />
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
                    <View style={{ paddingVertical: 8 }}>
                      <Text style={s.rowText}>Couleur d'accent</Text>
                      <View style={s.chips}>
                        {ACCENTS.map((c) => (
                          <TouchableOpacity
                            key={c}
                            onPress={() => updatePref('accent', c)}
                            style={[s.swatch, { backgroundColor: c }, prefs.accent === c && s.swatchOn]}
                          />
                        ))}
                      </View>
                    </View>
                  </Section>

                  <Section title="Écran">
                    <Toggle label="Mode nuit" hint="Assombrit tout l'affichage" value={prefs.nightMode} onChange={(v) => updatePref('nightMode', v)} />
                    <Toggle label="Protection anti-marquage" hint="Décale l'image de quelques pixels" value={prefs.antiBurnIn} onChange={(v) => updatePref('antiBurnIn', v)} />
                    <ActionButton label="Lancer le mode Always-On" onPress={enterAod} />
                    <Text style={s.hint}>Écran noir, horloge et pochette, luminosité minimale. Touche l'écran pour quitter.</Text>
                  </Section>
                </>
              )}

              {Native && (
                <Section title="Téléphone (fond d'écran, widgets, veille)">
                  {!native.access ? (
                    <>
                      <Text style={s.p}>
                        Pour suivre la musique même quand Pochette est fermée, Android demande l'« accès aux notifications ».
                        Pochette ne lit pas tes notifications : elle s'en sert uniquement pour connaître le morceau en cours.
                      </Text>
                      <ActionButton label="Autoriser l'accès" onPress={() => Native.openNotificationAccessSettings()} />
                      <Text style={[s.hint, { marginTop: 10 }]}>
                        Si l'interrupteur est grisé : ouvre les infos de l'appli, touche ⋮ en haut à droite puis
                        « Autoriser les paramètres restreints », et réessaie.
                      </Text>
                      <ActionButton secondary label="Infos de l'appli" onPress={() => Native.openAppDetails()} />
                    </>
                  ) : (
                    <Text style={s.hint}>
                      {np ? `Détecté : ${np.title}${np.artist ? ` — ${np.artist}` : ''}` : 'Accès activé. Lance un morceau pour le voir apparaître ici.'}
                    </Text>
                  )}

                  <Choice
                    label="Musique suivie"
                    value={ns.source}
                    disabled={!native.access}
                    onChange={(v) => setNativeSetting({ source: v })}
                    options={[['spotify', 'Spotify'], ['all', 'Toutes les applis']]}
                  />

                  <Toggle
                    label="Fond d'écran en direct"
                    hint="Change le fond d'écran à chaque nouvelle pochette"
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
                    options={[['blur', 'Pochette sur fond flou'], ['fill', 'Plein écran']]}
                  />
                  <ActionButton secondary label="Appliquer maintenant" disabled={!native.access || !ns.wallpaperEnabled} onPress={applyWallpaperNow} />

                  <Text style={[s.rowText, { marginTop: 18 }]}>Widgets</Text>
                  <ActionButton secondary label="Ajouter « Pochette » (carré)" onPress={() => addWidget('cover')} />
                  <ActionButton secondary label="Ajouter « Lecture en cours » (avec boutons)" onPress={() => addWidget('nowplaying')} />

                  <Text style={[s.rowText, { marginTop: 18 }]}>Économiseur d'écran</Text>
                  <Text style={s.hint}>
                    Horloge et pochette sur fond noir pendant que le téléphone charge, même appli fermée.
                    Choisis « Pochette » dans les réglages qui vont s'ouvrir.
                  </Text>
                  <ActionButton secondary label="Ouvrir les réglages de l'économiseur" onPress={() => Native.openScreenSaverSettings()} />
                </Section>
              )}

              <Section title="Compte Spotify">
                <ActionButton secondary label="Changer le Client ID" onPress={changeClientId} />
                {stage !== 'setup' && <ActionButton secondary label="Se déconnecter" onPress={logout} />}
              </Section>

              <ActionButton label="Fermer" onPress={() => setSettingsOpen(false)} />
            </ScrollView>
          </Pressable>
        </Pressable>
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
          <Clock style={s.aodClock} />
          {track && track.image ? (
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
  const compact = prefs.showInfo || prefs.showProgress || prefs.showClock;
  const coverSize = landscape
    ? (compact ? Math.min(height * 0.8, width * 0.45) : Math.min(height * 0.88, width * 0.9))
    : (compact ? Math.min(width * 0.88, height * 0.55) : Math.min(width * 0.92, height * 0.8));
  const barWidth = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const textAlign = immersive || landscape ? 'left' : 'center';

  const infoBlock = track && compact ? (
    <>
      {prefs.showClock && <Clock style={[s.clock, { textAlign }]} />}
      {prefs.showInfo && (
        <>
          <Text numberOfLines={1} style={[s.title, { textAlign }]}>{track.title}</Text>
          <Text numberOfLines={1} style={[s.sub, { textAlign }]}>
            {[track.artist, track.album].filter(Boolean).join(' — ')}
          </Text>
        </>
      )}
      {prefs.showProgress && track.durationMs ? (
        <View style={s.barTrack}>
          <Animated.View style={[s.barFill, { width: barWidth, backgroundColor: prefs.accent }]} />
        </View>
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
        {!track ? (
          <View style={[s.center, { flex: 1, padding: 24 }]}>
            {prefs.showClock && <Clock style={[s.clock, { textAlign: 'center', marginBottom: 24 }]} />}
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
          <View style={[s.center, { flex: 1, flexDirection: landscape ? 'row' : 'column', padding: 20 }]}>
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

      {renderSettings()}
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
