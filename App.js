import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, ActivityIndicator,
  Alert, Animated, StyleSheet, useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';

WebBrowser.maybeCompleteAuthSession();

const REDIRECT_URI = 'pochette://callback';
const SCOPES = ['user-read-currently-playing', 'user-read-playback-state'];
const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};
const API_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const POLL_MS = 3000;

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
  const images = (item.album && item.album.images) || item.images || [];
  const artists = item.artists
    ? item.artists.map((a) => a.name).join(', ')
    : (item.show && item.show.publisher) || '';
  return {
    title: item.name,
    artist: artists,
    album: (item.album && item.album.name) || (item.show && item.show.name) || '',
    image: images[0] ? images[0].url : null,
    isPlaying: !!data.is_playing,
  };
}

export default function App() {
  useKeepAwake(); // l'écran reste allumé tant que l'app est ouverte
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const [stage, setStage] = useState('loading'); // loading | setup | login | ready
  const [clientInput, setClientInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState(null);
  const auth = useRef({ clientId: null, access: null, expiresAt: 0, refresh: null });
  const fade = useRef(new Animated.Value(0)).current;

  // Chargement initial
  useEffect(() => {
    (async () => {
      const a = auth.current;
      a.clientId = await sget('clientId');
      a.refresh = await sget('refreshToken');
      a.access = await sget('accessToken');
      a.expiresAt = Number((await sget('expiresAt')) || 0);
      setStage(!a.clientId ? 'setup' : !a.refresh ? 'login' : 'ready');
    })();
  }, []);

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

  // Interrogation régulière de Spotify
  useEffect(() => {
    if (stage !== 'ready') return undefined;
    let stop = false;
    let timer;
    const loop = async () => {
      let delay = POLL_MS;
      try {
        const token = await getAccessToken();
        const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 204) setTrack(null);
        else if (res.status === 200) setTrack(normalize(await res.json()));
        else if (res.status === 401) auth.current.access = null;
        else if (res.status === 429) delay = (parseInt(res.headers.get('retry-after') || '5', 10) + 1) * 1000;
      } catch (e) {
        if (e && (e.status === 400 || e.status === 401)) {
          await clearTokens();
          if (!stop) setStage('login');
          return;
        }
      }
      if (!stop) timer = setTimeout(loop, delay);
    };
    loop();
    return () => { stop = true; clearTimeout(timer); };
  }, [stage]);

  // Actions
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

  function openSettings() {
    Alert.alert('Réglages', undefined, [
      {
        text: 'Changer le Client ID',
        onPress: async () => {
          await sdel('clientId'); await clearTokens();
          auth.current.clientId = null; setTrack(null); setClientInput(''); setStage('setup');
        },
      },
      {
        text: 'Se déconnecter',
        style: 'destructive',
        onPress: async () => { await clearTokens(); setTrack(null); setStage('login'); },
      },
      { text: 'Annuler', style: 'cancel' },
    ]);
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
          />
          <TouchableOpacity style={s.btn} onPress={saveClientId}>
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
            <Text style={s.btnText}>Se connecter avec Spotify</Text>
          </TouchableOpacity>
          {!!error && <Text style={s.err}>{error}</Text>}
          <TouchableOpacity onPress={openSettings} style={{ marginTop: 16 }}>
            <Text style={[s.p, { textAlign: 'center', opacity: 0.6 }]}>Réglages</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // stage === 'ready'
  const coverSize = landscape
    ? Math.min(height * 0.8, width * 0.45)
    : Math.min(width * 0.88, height * 0.55);

  return (
    <View style={s.screen}>
      <StatusBar hidden />
      {track && track.image ? (
        <>
          <Image source={{ uri: track.image }} style={StyleSheet.absoluteFill} blurRadius={30} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.6)' }]} />
        </>
      ) : null}

      {track ? (
        <View style={[s.center, { flex: 1, flexDirection: landscape ? 'row' : 'column', padding: 20 }]}>
          <View style={[s.coverWrap, { width: coverSize, height: coverSize }]}>
            {track.image ? (
              <Animated.Image
                key={track.image}
                source={{ uri: track.image }}
                style={{ width: coverSize, height: coverSize, borderRadius: 10, opacity: fade }}
                onLoadStart={() => fade.setValue(0)}
                onLoad={() => Animated.timing(fade, { toValue: 1, duration: 600, useNativeDriver: true }).start()}
              />
            ) : null}
            {!track.isPlaying && <View style={[s.pausedOverlay, { borderRadius: 10 }]} />}
          </View>
          <View style={{ marginTop: landscape ? 0 : 24, marginLeft: landscape ? 28 : 0, flex: landscape ? 1 : 0, width: landscape ? undefined : '100%' }}>
            <Text numberOfLines={1} style={[s.title, { textAlign: landscape ? 'left' : 'center' }]}>{track.title}</Text>
            <Text numberOfLines={1} style={[s.sub, { textAlign: landscape ? 'left' : 'center' }]}>
              {[track.artist, track.album].filter(Boolean).join(' — ')}
            </Text>
          </View>
        </View>
      ) : (
        <View style={[s.center, { flex: 1 }]}>
          <Text style={{ fontSize: 56, marginBottom: 12 }}>🎵</Text>
          <Text style={s.title}>Lance ta musique sur Spotify</Text>
          <Text style={[s.sub, { marginTop: 6 }]}>La pochette s'affichera ici automatiquement.</Text>
        </View>
      )}

      <TouchableOpacity style={s.gear} onPress={openSettings}>
        <Text style={{ color: '#fff', fontSize: 18 }}>⚙</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 460, backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 18, padding: 22 },
  h1: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  p: { color: '#fff', opacity: 0.9, fontSize: 14, lineHeight: 21, marginBottom: 10 },
  code: {
    color: '#fff', backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 8, paddingVertical: 6,
    borderRadius: 6, fontSize: 13, alignSelf: 'flex-start', marginBottom: 12,
  },
  input: {
    color: '#fff', backgroundColor: 'rgba(0,0,0,0.45)', borderColor: 'rgba(255,255,255,0.25)', borderWidth: 1,
    borderRadius: 10, padding: 14, fontSize: 16, marginBottom: 12,
  },
  btn: { backgroundColor: '#1db954', borderRadius: 999, paddingVertical: 14, alignItems: 'center' },
  btnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  err: { color: '#ff9a9a', fontSize: 13, marginTop: 12 },
  coverWrap: { shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 20, elevation: 16 },
  pausedOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  sub: { color: '#fff', opacity: 0.7, fontSize: 16, marginTop: 4 },
  gear: {
    position: 'absolute', top: 36, right: 16, width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center', opacity: 0.5,
  },
});
