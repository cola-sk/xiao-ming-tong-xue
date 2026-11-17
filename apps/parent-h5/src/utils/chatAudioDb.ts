/**
 * 家长端双向微聊语音本地持久化存储 (`IndexedDB`)
 *
 * 设计方案：
 * - 云端 Neon PostgreSQL 仅作为「阅后即焚」中转通道；
 * - 家长端将自己录制的 WAV 语音、以及从 ESP32 拉取到的宝贝原声 WAV，统一存入浏览器 IndexedDB；
 * - 支持页面刷新/离线随时回听历史语音，同时按「最多 200 条 / 总体积上限 100MB」执行 LRU 自动淘汰。
 */

const DB_NAME = 'xiaoming_wechat_audio_db';
const DB_VERSION = 1;
const STORE_NAME = 'audio_blobs';

export const PARENT_CHAT_AUDIO_MAX_COUNT = 200;
export const PARENT_CHAT_AUDIO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

interface StoredChatAudio {
  id: string;
  blob: Blob;
  sizeBytes: number;
  createdAt: number;
}

function openAudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this environment'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function pruneIfExceedsQuota(db: IDBDatabase): Promise<void> {
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('createdAt');
    const req = idx.getAll();

    req.onsuccess = () => {
      const items = (req.result || []) as StoredChatAudio[];
      let totalBytes = items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
      let remaining = items.length;

      // 按 createdAt 升序删除最旧记录，直到满足条数与总体积限制
      for (const item of items) {
        if (remaining <= PARENT_CHAT_AUDIO_MAX_COUNT && totalBytes <= PARENT_CHAT_AUDIO_MAX_BYTES) {
          break;
        }
        store.delete(item.id);
        totalBytes -= item.sizeBytes || 0;
        remaining -= 1;
      }
      resolve();
    };
    req.onerror = () => resolve();
  });
}

/**
 * 保存微聊语音 Blob 到家长端本地 IndexedDB
 */
export async function saveLocalChatAudio(msgId: string, blob: Blob, required = false): Promise<void> {
  if (!msgId || !blob || blob.size === 0) return;
  try {
    const db = await openAudioDb();
    const record: StoredChatAudio = {
      id: msgId,
      blob,
      sizeBytes: blob.size,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await pruneIfExceedsQuota(db);
    db.close();
  } catch (err) {
    if (required) throw err;
    // 隐私模式或不支持 IndexedDB 时静默跳过
  }
}

/**
 * 读取本地 IndexedDB 中缓存的语音 Blob 并生成临时 ObjectURL 供 `<audio>` 播放
 */
export async function getLocalChatAudioUrl(msgId: string): Promise<string | null> {
  if (!msgId) return null;
  try {
    const db = await openAudioDb();
    const record = await new Promise<StoredChatAudio | undefined>(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(msgId);
      req.onsuccess = () => resolve(req.result as StoredChatAudio | undefined);
      req.onerror = () => resolve(undefined);
    });
    db.close();
    if (record?.blob) {
      return URL.createObjectURL(record.blob);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 查询本地微聊音频缓存统计（已存条数 & 占用空间）
 */
export async function getLocalChatAudioStats(): Promise<{ count: number; totalBytes: number }> {
  try {
    const db = await openAudioDb();
    const items = await new Promise<StoredChatAudio[]>(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result || []) as StoredChatAudio[]);
      req.onerror = () => resolve([]);
    });
    db.close();
    return {
      count: items.length,
      totalBytes: items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    };
  } catch {
    return { count: 0, totalBytes: 0 };
  }
}

/**
 * 清空家长端本地微聊语音缓存
 */
export async function clearLocalChatAudio(): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // ignore
  }
}
