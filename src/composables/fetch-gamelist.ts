import { Game } from '@/types/types';
import { fetch, ClientOptions } from '@tauri-apps/plugin-http';
import { tryOnMounted, useAsyncState } from '@vueuse/core';
import { ref, watch, shallowRef } from 'vue';
import { message } from '@tauri-apps/plugin-dialog'; 
import { invoke } from '@tauri-apps/api/core';
import { useGlobalState } from './app-state';

// Discord sometimes adds a game to its detectable-applications list before it
// gets around to registering real executable names for it (the API returns
// `executables: []`). When we know the real name, override it here by
// Discord application id so the right dummy exe gets created regardless of
// where the game list came from (Discord API, GitHub mirror, or bundled) -
// relying on the generic fallback-name generator alone would produce a wrong
// name like "EASportsFC27.exe" instead of the real "fc27.exe".
const KNOWN_EXECUTABLE_OVERRIDES: Record<string, Game['executables']> = {
    // EA Sports FC 27
    '1531874756096295054': [
        { is_launcher: false, name: 'ea sports fc 27/fc27.exe', os: 'win32' },
        { is_launcher: false, name: 'ea sports fc 27/fc27_trial.exe', os: 'win32' },
    ],
};

function applyKnownExecutableOverrides(games: Game[]): Game[] {
    return games.map(game => {
        const override = KNOWN_EXECUTABLE_OVERRIDES[game.id];
        if (override && (!game.executables || game.executables.length === 0)) {
            return { ...game, executables: override };
        }
        return game;
    });
}

export function useFetchGameList() {
    const { addLog } = useGlobalState();
    async function fetchGameListGHMirror() {
        addLog('Fetching game list from GitHub mirror...'); 
        const response = await invoke('fetch_gamelist_gh_mirror');
        return response as Game[] | unknown[] | undefined;
    }
    async function fetchGameListFromDiscord (){
        addLog('Fetching game list directly from discord...'); 
        const response = await invoke('fetch_gamelist_from_discord');
        return response as Game[] | unknown[] | undefined;
    };

    // const fetchBundledGameList = fetch(window.location.origin+'/gamelist.json', { method: 'GET' });

    const { 
        state: gameListGHMirror,
        error: errorGH,
        isReady: isReadyGH,
        execute: executeGH,
        isLoading: isLoadingGH
    } = useAsyncState<Game[] | unknown[] | undefined>(fetchGameListGHMirror, [], {
            immediate: false,
            resetOnExecute: true,
        });
    const { 
        state: gameListFromDiscord, 
        error: errorDiscord,
        isReady: isReadyDiscord,
        execute: executeDiscord,
        isLoading: isLoadingDiscord
    } = useAsyncState(fetchGameListFromDiscord, [], {
        immediate: false,
        resetOnExecute: true,
    });
    const { 
        state: bundledGameList,
        error: errorBundled,
        isReady: isReadyBundled,
        execute: executeBundled,
        isLoading: isLoadingBundled
    } = useAsyncState(() => {
        const result = import('../assets/gamelist.json').then(res=>res.default);
        addLog('Fetching bundled game list for fallback...');
        return result;
    }, [], {
        immediate: false,
        resetOnExecute: true,
    });

    const fetchError = ref<string | null>(null);

    const gameDB = shallowRef<Game[]>([]);

    const allFetchDone = ref(false);

    function isValidGameList(data: any): boolean {
        return Array.isArray(data) && data[0] && 'aliases' in data[0] && 'name' in data[0] && 'executables' in data[0];
    }

    watch(() => isReadyGH.value, async (newVal) => {
        addLog('debug','isReadyGH: ' + newVal); 
    });

    watch(() => isReadyDiscord.value, async (newVal) => {
        addLog('debug','isReadyDiscord: ' + newVal);
    })
    
    watch(() => isReadyBundled.value, async (newVal) => {
        addLog('debug','isReadyBundled: ' + newVal); 
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    async function fetchGameList() { 
        allFetchDone.value = false;
        addLog('Fetching game list...');
        // Priority: Discord API first, then GitHub mirror fallback. Bundled as last resort.
        try {
           await Promise.all([executeDiscord(), executeBundled()]);
        } catch {
            addLog('error', 'Error executing fetch for Discord API or bundled game list.');
        }

        if (errorDiscord.value) { 
            fetchError.value = 'Error fetching game list from Discord API.';
            addLog('error','Error fetching game list from Discord API');
            await executeGH();
            if (errorGH.value) {
                fetchError.value = 'Error fetching game list from GitHub mirror.';
                addLog('error','Error fetching game list from GitHub mirror:');
                if (errorBundled.value) {
                    fetchError.value = 'Error fetching bundled game list.';
                    addLog('error','Error fetching bundled game list:');
                }
            }
        }
        // silently log error for bundled, as it's the last resort.
        if (errorBundled.value) {
            addLog('error','Error fetching bundled game list');
        }

        if (fetchError.value) {
            await message('There was an error fetching the latest game list.' + fetchError.value, {
                title: 'Game List Fetch Error',
                kind: 'error',
                buttons: {
                    ok: 'OK'
                }
            });
        }

        // Priority: Discord API > GitHub Mirror > Bundled
        if (gameListFromDiscord.value && gameListFromDiscord.value?.length > 0 && isValidGameList(gameListFromDiscord.value)) {
            gameDB.value = applyKnownExecutableOverrides(gameListFromDiscord.value as Game[] || []);
            addLog('Using game list from Discord API. ' + gameListFromDiscord.value.length + ' entries.');
        } else if (gameListGHMirror.value && gameListGHMirror.value?.length > 0 && isValidGameList(gameListGHMirror.value)) {
            gameDB.value = applyKnownExecutableOverrides(gameListGHMirror.value as Game[] || []);
            addLog('Using game list from GitHub mirror. ' + gameListGHMirror.value.length + ' entries.');
        } else {
            // bundled is always present.
            addLog('Using bundled game list as fallback. ' + bundledGameList.value.length + ' entries.');
            gameDB.value = applyKnownExecutableOverrides(bundledGameList.value as Game[]);
        }

        // Set a timeout to delay setting allFetchDone to true, to allow UI to update.
      
        timeoutId = setTimeout(() => {
            allFetchDone.value = true;
        }, 1800);

    }

    watch(allFetchDone, (newVal) => {
        if (newVal && timeoutId) {
            clearTimeout(timeoutId);
        }
    });

    tryOnMounted(async () => {
        await fetchGameList();
    });


    return {
        gameListGHMirror,
        gameListFromDiscord,
        bundledGameList,
        fetchError,
        isReadyGH,
        isReadyDiscord,
        isReadyBundled,
        gameDB,
        fetchGameList,
        isLoadingGH,
        isLoadingDiscord,
        isLoadingBundled,
        allFetchDone
    }
}