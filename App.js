import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Button, TextInput, TouchableOpacity, ActivityIndicator, Alert, Image, FlatList, Share, Platform, ScrollView } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import * as TextRecognition from 'expo-text-recognition';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';

const API_URL = 'https://instanotes-49k2.onrender.com'; // Jouw Render backend

const HISTORY_KEY = 'instanotes_history_v2';

function HomeScreen({ navigation }) {
  return (
    <View style={styles.containerCenter}>
      <Text style={styles.welcomeTitle}>Voor mijn ambitieuze leerlingen</Text>
      <Text style={styles.welcomeText}>
        Voor mijn ambitieuze leerlingen Layla, Dennis, Mohamed, Ires en Dounia.{'\n\n'}
        Veel plezier met de app :) {'\n\n'}Van Juf Mariam
      </Text>
      <TouchableOpacity style={styles.primaryButton} onPress={() => navigation.navigate('Actions')}>
        <Text style={styles.primaryButtonText}>Begin</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.secondaryButton, { marginTop: 12 }]} onPress={() => navigation.navigate('History')}>
        <Text style={styles.secondaryButtonText}>Bekijk samenvattingen</Text>
      </TouchableOpacity>
    </View>
  );
}

function ActionsScreen({ navigation }) {
  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Kies een actie</Text>

      <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Editor', { mode: 'camera' })}>
        <Text style={styles.actionButtonText}>Scan tekst (camera)</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Editor', { mode: 'photo' })}>
        <Text style={styles.actionButtonText}>Kies foto (galerij)</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('Editor', { mode: 'paste' })}>
        <Text style={styles.actionButtonText}>Plak tekst</Text>
      </TouchableOpacity>
    </View>
  );
}

function EditorScreen({ route, navigation }) {
  const { mode } = route.params || {};
  const [image, setImage] = useState(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [source, setSource] = useState(null);

  useEffect(() => {
    (async () => {
      if (mode === 'camera' || mode === 'photo') {
        await pickImage(mode === 'camera');
      } else if (mode === 'paste') {
        // nothing, user will paste
      }
    })();
  }, []);

  async function pickImage(useCamera = false) {
    try {
      if (useCamera) {
        const camPerm = await ImagePicker.requestCameraPermissionsAsync();
        if (!camPerm.granted) return Alert.alert('Camera permission', 'Toegang tot camera geweigerd');
        const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
        if (!result.cancelled && result.uri) {
          setImage(result.uri);
          setText(''); setSummary(null); setSource(null);
        }
      } else {
        const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!libPerm.granted) return Alert.alert('Media permission', 'Toegang tot foto\'s geweigerd');
        const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
        if (!result.cancelled && result.uri) {
          setImage(result.uri);
          setText(''); setSummary(null); setSource(null);
        }
      }
    } catch (err) {
      console.error('pickImage', err);
      Alert.alert('Fout', 'Kon afbeelding niet openen');
    }
  }

  async function doOCR() {
    if (!image) return Alert.alert('Geen afbeelding', 'Kies eerst een foto of scan met camera');
    setLoading(true);
    try {
      const available = await TextRecognition.isAvailableAsync();
      if (!available) {
        Alert.alert('OCR niet beschikbaar', 'OCR is op dit apparaat niet beschikbaar');
        setLoading(false);
        return;
      }
      const res = await TextRecognition.recognize(image);
      // res.blocks / res.text? Use joined lines fallback
      let recognized = '';
      if (Array.isArray(res) && res.length) {
        // expo-text-recognition returns array of blocks; join texts
        recognized = res.map(b => b.text).join('\n');
      } else if (res.text) {
        recognized = res.text;
      } else {
        // Fallback: try small structure
        recognized = String(res);
      }
      setText(recognized);
      setSummary(null); setSource(null);
    } catch (err) {
      console.error('OCR error', err);
      Alert.alert('OCR fout', String(err));
    } finally {
      setLoading(false);
    }
  }

  async function doSummarize() {
    if (!text || !text.trim()) return Alert.alert('Geen tekst', 'Typ of plak eerst tekst of voer OCR uit.');
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const ct = res.headers.get('content-type') || '';
      const raw = await res.text();
      if (!ct.includes('application/json')) throw new Error('Server returned non-JSON: ' + raw);
      const json = JSON.parse(raw);
      if (json.error) throw new Error(json.error || JSON.stringify(json));
      setSummary(json.summary || '(geen samenvatting)');
      setSource(json.source || 'unknown');

      // Save to history
      const item = {
        id: Date.now().toString(),
        date: new Date().toISOString(),
        text,
        summary: json.summary || '',
        source: json.source || 'unknown'
      };
      const rawHistory = await AsyncStorage.getItem(HISTORY_KEY);
      const history = rawHistory ? JSON.parse(rawHistory) : [];
      await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify([item, ...history].slice(0, 200)));
      Alert.alert('Opgeslagen', 'Samenvatting is opgeslagen in Geschiedenis');
    } catch (err) {
      console.error('summarize error', err);
      Alert.alert('Samenvatting mislukt', String(err));
    } finally {
      setLoading(false);
    }
  }

  async function doShare() {
    if (!summary && !text) return Alert.alert('Niets om te delen');
    const toShare = summary || text;
    try {
      await Share.share({ message: toShare });
    } catch (e) {
      Alert.alert('Delen mislukt', String(e));
    }
  }

  async function doCopy() {
    const toCopy = summary || text;
    if (!toCopy) return;
    await Clipboard.setStringAsync(toCopy);
    Alert.alert('Gekopieerd', 'Tekst gekopieerd naar klembord');
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.sectionTitle}>Editor</Text>

      {image ? <Image source={{ uri: image }} style={styles.previewImage} /> : null}

      <TouchableOpacity style={styles.smallButton} onPress={() => pickImage(false)}>
        <Text style={styles.smallButtonText}>Nieuwe foto kiezen</Text>
      </TouchableOpacity>

      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="De tekst verschijnt hier (of plak)"
        style={styles.textArea}
        textAlignVertical="top"
      />

      <View style={styles.row}>
        <TouchableOpacity style={styles.actionBtn} onPress={doOCR} disabled={loading || !image}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionBtnText}>OCR uitvoeren</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={doSummarize} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionBtnText}>Samenvatten</Text>}
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.goBack()}>
          <Text style={styles.secondaryButtonText}>Terug</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={doShare}>
          <Text style={styles.secondaryButtonText}>Delen</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={doCopy}>
          <Text style={styles.secondaryButtonText}>Kopiëren</Text>
        </TouchableOpacity>
      </View>

      <View style={{ marginTop: 12 }}>
        <Text style={{ fontWeight: '700' }}>Samenvatting</Text>
        <View style={styles.summaryBox}>
          <Text>{summary ?? '(nog geen samenvatting)'}</Text>
          <Text style={{ color: '#666', marginTop: 8 }}>Bron: {source ?? '-'}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

function HistoryScreen({ navigation }) {
  const [history, setHistory] = useState([]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    load();
    return unsub;
  }, []);

  async function load() {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    setHistory(raw ? JSON.parse(raw) : []);
  }

  async function removeItem(id) {
    const next = history.filter(h => h.id !== id);
    setHistory(next);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  }

  async function clearAll() {
    await AsyncStorage.removeItem(HISTORY_KEY);
    setHistory([]);
  }

  function useItem(item) {
    navigation.navigate('Editor', { mode: 'paste' });
    setTimeout(() => {
      // put item into editor by saving to clipboard or AsyncStorage temp
      Clipboard.setStringAsync(item.text);
      Alert.alert('Gereed', 'Tekst naar klembord gekopieerd. Plak in editor.');
    }, 250);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Geschiedenis</Text>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
        <TouchableOpacity style={styles.secondaryButton} onPress={clearAll}>
          <Text style={styles.secondaryButtonText}>Wis alles</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={history}
        keyExtractor={i => i.id}
        ListEmptyComponent={<Text style={{ color: '#666' }}>Nog geen opgeslagen samenvattingen.</Text>}
        renderItem={({ item }) => (
          <View style={styles.historyCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.historyDate}>{new Date(item.date).toLocaleString()}</Text>
              <Text numberOfLines={3} style={styles.historySummary}>{item.summary}</Text>
              <Text style={styles.historyMeta}>Bron: {item.source}</Text>
            </View>
            <View style={{ marginLeft: 8, justifyContent: 'space-between' }}>
              <TouchableOpacity style={styles.hAction} onPress={() => { Clipboard.setStringAsync(item.summary); Alert.alert('Gekopieerd'); }}>
                <Text style={styles.hActionText}>Kopiëren</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.hAction} onPress={() => { Share.share({ message: item.summary }); }}>
                <Text style={styles.hActionText}>Delen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.hAction} onPress={() => useItem(item)}>
                <Text style={styles.hActionText}>Gebruik</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.hAction, { borderColor: '#f44336' }]} onPress={() => removeItem(item.id)}>
                <Text style={[styles.hActionText, { color: '#f44336' }]}>Verwijder</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Home">
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'InstaNotes' }} />
        <Stack.Screen name="Actions" component={ActionsScreen} options={{ title: 'Acties' }} />
        <Stack.Screen name="Editor" component={EditorScreen} options={{ title: 'Editor' }} />
        <Stack.Screen name="History" component={HistoryScreen} options={{ title: 'Geschiedenis' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 14, backgroundColor: '#f6fbff' },
  containerCenter: { flex: 1, padding: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f6fbff' },
  welcomeTitle: { fontSize: 22, fontWeight: '700', color: '#1e3a8a', marginBottom: 8, textAlign: 'center' },
  welcomeText: { fontSize: 16, color: '#111', textAlign: 'center' },

  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },

  actionButton: { backgroundColor: '#fff', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#e6f0ff', marginBottom: 10 },
  actionButtonText: { fontSize: 16 },

  primaryButton: { backgroundColor: '#1e3a8a', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
  primaryButtonText: { color: '#fff', fontWeight: '600', fontSize: 16 },

  secondaryButton: { backgroundColor: '#fff', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#d1d5db' },
  secondaryButtonText: { color: '#333' },

  previewImage: { width: '100%', height: 220, borderRadius: 8, marginBottom: 8 },
  smallButton: { backgroundColor: '#fff', padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#e6f0ff', marginBottom: 8, alignSelf: 'flex-start' },
  smallButtonText: { color: '#333' },

  textArea: { minHeight: 140, backgroundColor: '#fff', borderRadius: 10, padding: 12, borderWidth: 1, borderColor: '#e6f7ff', fontSize: 15 },

  row: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  actionBtn: { flex: 1, backgroundColor: '#1e3a8a', padding: 12, borderRadius: 10, marginRight: 8, alignItems: 'center' },
  actionBtnText: { color: '#fff', fontWeight: '600' },

  summaryBox: { backgroundColor: '#fff', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#eefaff', marginTop: 8 },

  historyCard: { backgroundColor: '#fff', padding: 12, borderRadius: 10, marginBottom: 10, borderWidth: 1, borderColor: '#eef6ff', flexDirection: 'row' },
  historyDate: { color: '#666', fontSize: 12, marginBottom: 6 },
  historySummary: { color: '#111', fontSize: 14, marginBottom: 6 },
  historyMeta: { color: '#666', fontSize: 12 },

  hAction: { paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#fff', marginBottom: 6 },
  hActionText: { color: '#333', fontSize: 12 }
});