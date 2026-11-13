// @ts-nocheck
// injector.ts serialises this function and evals it inside the Big Picture window, so it must stay ONE self-contained function.
// Holding R2/L2 in the library grid steps through the sort's groups (letters on A-Z, sections on other sorts) and jumps once on release.
// Steam's own R2/L2 step (its "AppGridFastScroll" hook) is not used: it animates every step, then clears the overlay label and moves
// focus, which made the overlay blink while held. Instead we read the same data that hook uses (the grid's childSections and its
// section/item refs), compute the groups ourselves, and drive Steam's overlay label, scroll and focus directly.
// Steam internals are found by shape, not minified name. window.libraryJump.undo() removes everything.
export function injectLibraryJump(configFromInjector) {
    return (() => {
        if (window.libraryJump) window.libraryJump.undo();

        const config = {
            HOLD_DELAY_MS: 450, // hold this long before repeating starts
            START_INTERVAL_MS: 250, // time between steps while held
            BTN_R2: 8, BTN_L2: 7, // button ids
            WRAP_ON_TAP: true,
            WRAP_MIN_GAP_MS: 300, // a hold that stopped at the end doesn't wrap on a press this soon after its release
            LABEL_LINGER_MS: 350, // keep the overlay letter this long after landing
            LAND_TIMEOUT_MS: 1500, // keep re-scrolling/focusing this long while the virtualised grid mounts the target tile
            SORT_ALPHABETICAL: 1, SORT_ACHIEVEMENTS: 2, SORT_FRIENDS_PLAYING: 10, // Steam's eSortBy values with one section
        };
        Object.assign(config, configFromInjector || {});

        const state = {
            heldButton: null,
            repeatTimer: null,
            press: null, // { grid, groups, groupIndex, wrapped } for the press in progress
            landingId: 0,
            labelClearTimer: null,
            lastRelease: { at: 0, holdStoppedAtEnd: false },
            warnedGridNotFound: false,
            focusedTileByTab: new Map(), // tab name -> { sectionIndex, itemIndex, appid, sortBy } of the last focused tile
            knownScrollers: new WeakSet(), // grid scrollers already seen; a new one means the grid was remounted
        };

        const getGridScroller = () => document.querySelector("._TabContentsScroll");

        // The library grid component (props childSections, eSortBy, elScrollElement) sits below the scroller. Its first hooks come
        // from Steam's fast-scroll hook: section ref, item ref, Map "section_item" -> tile nav ref (mounted tiles only), the overlay
        // label state, and the overlay's nav ref (a focusable placeholder that holds focus while the grid scrolls).
        const readSteamGrid = () => {
            const scrollerElement = getGridScroller();
            if (!scrollerElement) return null;
            const fiberKey = Object.keys(scrollerElement).find((key) => key.startsWith("__reactFiber$"));
            const rootFiber = fiberKey && scrollerElement[fiberKey];
            const pending = rootFiber ? [rootFiber] : [];
            let gridFiber = null;
            for (let visited = 0; pending.length && visited < 30000; visited++) {
                const fiber = pending.pop();
                if (fiber.sibling && fiber !== rootFiber) pending.push(fiber.sibling);
                if (fiber.child) pending.push(fiber.child);
                const props = fiber.memoizedProps;
                if (
                    typeof fiber.type === "function" &&
                    props &&
                    Array.isArray(props.childSections) &&
                    "eSortBy" in props &&
                    "elScrollElement" in props
                ) {
                    gridFiber = fiber;
                    break;
                }
            }
            if (!gridFiber) return null;
            const hooks = [];
            for (let hook = gridFiber.memoizedState; hook && hooks.length < 5; hook = hook.next) hooks.push(hook);
            if (hooks.length < 5) return null;
            const [sectionHook, itemHook, tileMapHook, labelHook, placeholderHook] = hooks;
            const isRef = (value) => value && typeof value === "object" && "current" in value;
            const tileMap = isRef(tileMapHook.memoizedState) && tileMapHook.memoizedState.current;
            const looksRight =
                isRef(sectionHook.memoizedState) &&
                isRef(itemHook.memoizedState) &&
                tileMap &&
                typeof tileMap.get === "function" &&
                typeof tileMap.entries === "function" &&
                labelHook.queue &&
                typeof labelHook.queue.dispatch === "function" &&
                typeof labelHook.queue.lastRenderedState === "string" &&
                isRef(placeholderHook.memoizedState);
            if (!looksRight) return null;
            const props = gridFiber.memoizedProps;
            return {
                sections: props.childSections,
                sortBy: props.eSortBy,
                scrollElement: props.elScrollElement || scrollerElement,
                sectionRef: sectionHook.memoizedState,
                itemRef: itemHook.memoizedState,
                tileMap,
                labelQueue: labelHook.queue,
                placeholderNavRef: placeholderHook.memoizedState.current,
            };
        };

        const localize = (token) => {
            try {
                const manager = window.LocalizationManager || (window.opener && window.opener.LocalizationManager);
                const text = manager && manager.LocalizeString(token);
                return typeof text === "string" && text && text !== token ? text : null;
            } catch (error) {
                return null;
            }
        };
        const letterOf = (sortAs) => {
            const firstCharacter = String(sortAs || "").normalize("NFD").charAt(0).toLowerCase();
            return !firstCharacter || firstCharacter < "a" ? "#" : firstCharacter;
        };

        // Groups in list order, each { key, label, sectionIndex, itemIndex } where the item is the group's first game.
        // Matches Steam's own stepping: several sections step section by section; one section steps by letter (A-Z), by
        // completion percentage (Achievements) or by friends playing (then by letter); other one-section sorts don't step (null).
        const buildGroups = (grid) => {
            const groups = [];
            const keyToGroup = new Map();
            const addGroup = (key, label, sectionIndex, itemIndex) => {
                if (keyToGroup.has(key)) return;
                const group = { key, label, sectionIndex, itemIndex };
                keyToGroup.set(key, group);
                groups.push(group);
            };
            if (grid.sections.length > 1) {
                grid.sections.forEach((section, sectionIndex) => {
                    if (section && section.children && section.children.length)
                        addGroup("section:" + sectionIndex, String(section.subSectionName || ""), sectionIndex, 0);
                });
                return { groups, groupKeyAt: (sectionIndex) => "section:" + sectionIndex };
            }
            const apps = (grid.sections[0] && grid.sections[0].children) || [];
            let groupKeyAndLabel;
            if (grid.sortBy === config.SORT_ALPHABETICAL) {
                groupKeyAndLabel = (app) => {
                    const letter = letterOf(app.sort_as);
                    return ["letter:" + letter, letter];
                };
            } else if (grid.sortBy === config.SORT_ACHIEVEMENTS) {
                groupKeyAndLabel = (app) => {
                    const percent = app.GetAchievementPercentage();
                    const label =
                        percent === -1
                            ? localize("#Library_SortByPctAchievementsNoAchievements_Tag") || "-"
                            : (localize("#Library_SortByPctAchievementsComplete_Tag") || "%1$s%").replace("%1$s", percent);
                    return ["percent:" + percent, label];
                };
            } else if (grid.sortBy === config.SORT_FRIENDS_PLAYING) {
                groupKeyAndLabel = (app) => {
                    const friendsPlaying = app.GetFriendsPlaying();
                    if (!friendsPlaying) {
                        const letter = letterOf(app.sort_as);
                        return ["letter:" + letter, letter];
                    }
                    const template =
                        (friendsPlaying !== 1 && localize("#AppPortraitHover_FriendsPlaying_Plural")) ||
                        localize("#AppPortraitHover_FriendsPlaying") ||
                        "%1$s";
                    return ["friends:" + friendsPlaying, template.replace("%1$s", friendsPlaying)];
                };
            } else return null;
            const itemKeys = apps.map((app) => {
                const [key, label] = groupKeyAndLabel(app);
                return { key, label };
            });
            itemKeys.forEach(({ key, label }, itemIndex) => addGroup(key, label, 0, itemIndex));
            return { groups, groupKeyAt: (sectionIndex, itemIndex) => itemKeys[itemIndex] && itemKeys[itemIndex].key };
        };

        // Same formula Steam's fast scroll uses for its scroll target.
        const scrollTopFor = (grid, sectionIndex, itemIndex) => {
            const section = grid.sections[sectionIndex];
            const sectionElement = section && section.refSection && section.refSection.current;
            const itemsPerRow = section && section.refItemsPerRow && section.refItemsPerRow.current;
            if (!sectionElement || !itemsPerRow) return null;
            const row = Math.floor(itemIndex / itemsPerRow);
            const scrollPaddingTop =
                parseInt(getComputedStyle(grid.scrollElement).getPropertyValue("scroll-padding-top")) || 0;
            return sectionElement.offsetTop + row * (section.childHeight + section.nGridRowGap) - scrollPaddingTop + 8;
        };

        const parseTileKey = (key) => {
            const match = /^(\d+)_(\d+)$/.exec(key);
            return match ? { sectionIndex: +match[1], itemIndex: +match[2] } : null;
        };
        const tileHasFocus = (tileNavRef) => {
            try {
                return !!(tileNavRef && tileNavRef.BHasFocus());
            } catch (error) {
                return false;
            }
        };

        // The focused tile; else Steam's refs (set on every tile focus, cleared when focus leaves the grid); else the first tile in view.
        const currentPosition = (grid) => {
            for (const [key, tileNavRef] of grid.tileMap.entries())
                if (tileHasFocus(tileNavRef) && parseTileKey(key)) return parseTileKey(key);
            const sectionIndex = grid.sectionRef.current,
                itemIndex = grid.itemRef.current;
            if (
                typeof sectionIndex === "number" &&
                typeof itemIndex === "number" &&
                grid.sections[sectionIndex] &&
                itemIndex < grid.sections[sectionIndex].children.length
            )
                return { sectionIndex, itemIndex };
            let firstInView = null;
            for (const key of grid.tileMap.keys()) {
                const position = parseTileKey(key);
                if (!position) continue;
                const top = scrollTopFor(grid, position.sectionIndex, position.itemIndex);
                if (top === null || top < grid.scrollElement.scrollTop - 10) continue;
                if (
                    !firstInView ||
                    position.sectionIndex < firstInView.sectionIndex ||
                    (position.sectionIndex === firstInView.sectionIndex && position.itemIndex < firstInView.itemIndex)
                )
                    firstInView = position;
            }
            return firstInView;
        };

        const setLabel = (grid, text) => {
            clearTimeout(state.labelClearTimer);
            try {
                grid.labelQueue.dispatch(text);
            } catch (error) {}
        };
        const clearLabelSoon = (grid) => {
            clearTimeout(state.labelClearTimer);
            state.labelClearTimer = setTimeout(() => {
                if (!state.heldButton) setLabel(grid, "");
            }, config.LABEL_LINGER_MS);
        };

        // Scrolls to the group's first game and focuses it. The grid only mounts tiles near the viewport, and right after a fresh
        // load its height can still be growing, so retry each frame until the tile is mounted and focused.
        const landOn = (grid, group) => {
            const thisLandingId = ++state.landingId;
            const tileKey = group.sectionIndex + "_" + group.itemIndex;
            // Steam's own refs: with them set, Steam itself focuses the tile as soon as it mounts.
            grid.sectionRef.current = group.sectionIndex;
            grid.itemRef.current = group.itemIndex;
            const currentTile = [...grid.tileMap.values()].find(tileHasFocus);
            if (currentTile !== grid.tileMap.get(tileKey)) {
                // Park focus on the overlay first (as Steam does), so focus never drops out of the grid when the old tile unmounts.
                try {
                    if (grid.placeholderNavRef && grid.placeholderNavRef.current) grid.placeholderNavRef.current.TakeFocus();
                } catch (error) {}
            }
            const startedAt = performance.now();
            const attempt = () => {
                if (thisLandingId !== state.landingId || state.heldButton) return;
                const targetTile = grid.tileMap.get(tileKey);
                if (targetTile && tileHasFocus(targetTile)) return clearLabelSoon(grid);
                const wantedTop = scrollTopFor(grid, group.sectionIndex, group.itemIndex);
                if (wantedTop !== null && Math.abs(grid.scrollElement.scrollTop - wantedTop) > 2)
                    grid.scrollElement.scrollTo({ top: wantedTop, behavior: "instant" });
                if (targetTile) {
                    try {
                        targetTile.TakeFocus();
                    } catch (error) {}
                }
                if (performance.now() - startedAt > config.LAND_TIMEOUT_MS) {
                    console.warn("[library-jump] could not focus", tileKey, "after", config.LAND_TIMEOUT_MS, "ms");
                    return clearLabelSoon(grid);
                }
                requestAnimationFrame(attempt);
            };
            attempt();
        };

        // Switching library tabs (or opening a game and coming back) remounts the grid. Steam then restores focus from its
        // saved nav history: the tile's NavKey (appportrait_<appid>) if that tile is mounted, else the old *index* among the
        // mounted tiles. The grid mounts only ~70 tiles, so after a long jump that index points at a different game, and
        // focusing it scrolls the grid there. We remember the last focused tile per tab and, on the first focus in a new
        // grid, move focus back to it when Steam picked another one.
        const tabNameOf = (scrollerElement) => {
            const fiberKey = Object.keys(scrollerElement).find((key) => key.startsWith("__reactFiber$"));
            for (let fiber = fiberKey && scrollerElement[fiberKey]; fiber; fiber = fiber.return) {
                const props = fiber.memoizedProps;
                if (props && "parentOnScroll" in props && typeof props.name === "string") return props.name;
            }
            return null;
        };
        const tileKeyOfElement = (grid, element) => {
            for (const [key, tileNavRef] of grid.tileMap.entries()) {
                try {
                    const tileElement = tileNavRef.Node().m_element;
                    if (tileElement && tileElement.contains(element)) return key;
                } catch (error) {}
            }
            return null;
        };
        const appAt = (grid, sectionIndex, itemIndex) => {
            const section = grid.sections[sectionIndex];
            return (section && section.children && section.children[itemIndex]) || null;
        };
        // Where the remembered game is now; it is looked up by app id in case the list changed while the tab was away.
        const findRememberedTile = (grid, remembered) => {
            const appAtSavedPosition = appAt(grid, remembered.sectionIndex, remembered.itemIndex);
            if (appAtSavedPosition && appAtSavedPosition.appid === remembered.appid)
                return { sectionIndex: remembered.sectionIndex, itemIndex: remembered.itemIndex };
            for (let sectionIndex = 0; sectionIndex < grid.sections.length; sectionIndex++) {
                const apps = (grid.sections[sectionIndex] && grid.sections[sectionIndex].children) || [];
                const itemIndex = apps.findIndex((app) => app && app.appid === remembered.appid);
                if (itemIndex !== -1) return { sectionIndex, itemIndex };
            }
            return null;
        };
        const onFocusIn = (event) => {
            const scrollerElement = getGridScroller();
            if (!scrollerElement || !(event.target instanceof Node) || !scrollerElement.contains(event.target)) return;
            const grid = readSteamGrid();
            if (!grid) return;
            const focusedKey = tileKeyOfElement(grid, event.target);
            const focusedPosition = focusedKey && parseTileKey(focusedKey);
            if (!focusedPosition) return; // the overlay placeholder, not a tile
            const tabName = tabNameOf(scrollerElement) || "";
            const isNewGrid = !state.knownScrollers.has(scrollerElement);
            state.knownScrollers.add(scrollerElement);
            const remembered = state.focusedTileByTab.get(tabName);
            if (isNewGrid && remembered && remembered.sortBy === grid.sortBy && !state.heldButton) {
                const rememberedPosition = findRememberedTile(grid, remembered);
                const isOtherTile =
                    rememberedPosition &&
                    (rememberedPosition.sectionIndex !== focusedPosition.sectionIndex ||
                        rememberedPosition.itemIndex !== focusedPosition.itemIndex);
                if (isOtherTile) {
                    // After Steam's restore has finished; the landing's own focus event then records the position.
                    requestAnimationFrame(() => landOn(readSteamGrid() || grid, rememberedPosition));
                    return;
                }
            }
            const focusedApp = appAt(grid, focusedPosition.sectionIndex, focusedPosition.itemIndex);
            state.focusedTileByTab.set(tabName, {
                sectionIndex: focusedPosition.sectionIndex,
                itemIndex: focusedPosition.itemIndex,
                appid: focusedApp && focusedApp.appid,
                sortBy: grid.sortBy,
            });
        };

        const stopRepeating = () => {
            clearTimeout(state.repeatTimer);
            state.repeatTimer = null;
        };
        const scheduleRepeat = (direction, delayMs) => {
            state.repeatTimer = setTimeout(() => {
                const press = state.press;
                if (!state.heldButton || !press) return;
                const nextIndex = press.groupIndex + direction;
                if (nextIndex < 0 || nextIndex >= press.groups.length) {
                    press.stoppedAtEnd = true; // holding never wraps
                    return;
                }
                press.groupIndex = nextIndex;
                setLabel(press.grid, press.groups[nextIndex].label);
                scheduleRepeat(direction, config.START_INTERVAL_MS);
            }, delayMs);
        };

        const isTriggerButton = (button) => button === config.BTN_R2 || button === config.BTN_L2;
        const swallow = (event) => {
            event.stopImmediatePropagation();
            event.preventDefault(); // Steam's own fast-scroll handler must not also run
        };

        const onButtonDown = (event) => {
            const button = event.detail && event.detail.button;
            if (!isTriggerButton(button)) return;
            if (state.heldButton) return swallow(event); // repeats, or the other trigger while one is held
            const scrollerElement = getGridScroller();
            if (!scrollerElement || !(event.target instanceof Node) || !scrollerElement.contains(event.target)) return;
            const grid = readSteamGrid();
            if (!grid) {
                if (!state.warnedGridNotFound) console.warn("[library-jump] library grid not recognised; Steam handles R2/L2");
                state.warnedGridNotFound = true;
                return;
            }
            const grouping = buildGroups(grid);
            if (!grouping || !grouping.groups.length) return; // a sort Steam doesn't step either (e.g. Date Added)
            swallow(event);
            if (event.detail.is_repeat) return;
            const position = currentPosition(grid);
            if (!position) return;
            const { groups } = grouping;
            const direction = button === config.BTN_R2 ? 1 : -1;
            const currentKey = grouping.groupKeyAt(position.sectionIndex, position.itemIndex);
            const currentIndex = groups.findIndex((group) => group.key === currentKey);
            let groupIndex = (currentIndex === -1 ? 0 : currentIndex) + direction;
            let wrapped = false;
            if (groupIndex < 0 || groupIndex >= groups.length) {
                const justStoppedAtEnd =
                    state.lastRelease.holdStoppedAtEnd &&
                    performance.now() - state.lastRelease.at < config.WRAP_MIN_GAP_MS;
                if (!config.WRAP_ON_TAP || justStoppedAtEnd || groups.length < 2) return;
                groupIndex = direction > 0 ? 0 : groups.length - 1;
                wrapped = true;
            }
            state.landingId++; // cancel a landing still in progress
            state.heldButton = button;
            state.press = { grid, groups, groupIndex, wrapped, stoppedAtEnd: false };
            setLabel(grid, groups[groupIndex].label);
            if (!wrapped) scheduleRepeat(direction, config.HOLD_DELAY_MS); // a press that wraps doesn't repeat
        };

        const onButtonUp = (event) => {
            const button = event.detail && event.detail.button;
            if (!isTriggerButton(button) || !state.heldButton) return;
            swallow(event);
            if (state.heldButton !== button) return;
            stopRepeating();
            const press = state.press;
            state.heldButton = null;
            state.press = null;
            state.lastRelease = { at: performance.now(), holdStoppedAtEnd: press.stoppedAtEnd };
            landOn(press.grid, press.groups[press.groupIndex]);
        };

        window.addEventListener("vgp_onbuttondown", onButtonDown, true); // capture: runs before Steam's handlers
        window.addEventListener("vgp_onbuttonup", onButtonUp, true);
        window.addEventListener("focusin", onFocusIn, true);
        window.libraryJump = {
            config,
            state,
            label: () => {
                const grid = readSteamGrid();
                return grid ? grid.labelQueue.lastRenderedState : null;
            },
            undo() {
                window.removeEventListener("vgp_onbuttondown", onButtonDown, true);
                window.removeEventListener("vgp_onbuttonup", onButtonUp, true);
                window.removeEventListener("focusin", onFocusIn, true);
                stopRepeating();
                state.landingId++;
                clearTimeout(state.labelClearTimer);
                const grid = state.press && state.press.grid;
                state.heldButton = null;
                state.press = null;
                if (grid) setLabel(grid, "");
                delete window.libraryJump;
                return "undone (bpm)";
            },
        };
        return "installed";
    })();
}
