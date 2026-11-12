// @ts-nocheck
// injector.ts serialises this function and evals it inside the Big Picture window, so it must stay ONE self-contained function.
// R2/L2 normally step one section per press; this repeats Steam's own step while held and jumps once on release.
// Steam internals are found by shape, not minified name. If one isn't found we do nothing. window.libraryJump.undo() removes everything.
export function injectLibraryJump(configFromInjector) {
    return (() => {
        if (window.libraryJump) window.libraryJump.undo();

        const config = {
            HOLD_DELAY_MS: 450, // hold this long before repeating starts
            START_INTERVAL_MS: 250,
            BTN_R2: 8, BTN_L2: 7, // button ids
            LABEL_CHECK_MS: 60, // wait this long for Steam's label to change, to tell if a step was accepted
            FAST_END_MS: 40, // end Steam's 350 ms scroll animation this long after each step (-1 = never)
            RETRY_MS: 40,
            GIVE_UP_MS: 700, // stop retrying after this long: end of list
            OVERLAY_LINGER_MS: 500,
            ANIM_MS: 180,
            WRAP_ON_TAP: true,
            WRAP_MIN_GAP_MS: 300, // don't wrap right after a hold that just reached the end
        };
        Object.assign(config, configFromInjector || {});

        const getGridScroller = () => document.querySelector("._TabContentsScroll");

        const state = {
            heldButton: null,
            repeatTimer: null,
            swallowScroll: false, // true during hold/wrap: scrolls are recorded, not performed
            lastScrollTarget: null, // last scroll position Steam tried to set; where we jump on release
            scrollFocusCalls: 0, // scroll/focus calls on the grid; a change during a step means Steam stepped
            ignoreScrollIntoViewUntil: 0,
            hasStepped: false,
            steamHandledPress: false, // Steam consumed the last press (a step, or a refusal at a boundary)
            animatorWasActive: false, // Steam's animation was running before the last step
            lastReleaseAt: 0,
            releaseTimer: null,
            settleId: 0,
        };

        const findSteamGridHook = (matchComponent) => {
            const scrollerElement = getGridScroller();
            if (!scrollerElement) return null;
            const fiberKey = Object.keys(scrollerElement).find((key) =>
                key.startsWith("__reactFiber$"),
            );
            let gridFiber = scrollerElement[fiberKey];
            for (let depth = 0; gridFiber && depth < 80; depth++, gridFiber = gridFiber.return)
                if (
                    gridFiber.memoizedProps &&
                    "eSortBy" in gridFiber.memoizedProps &&
                    "elScrollElement" in gridFiber.memoizedProps
                )
                    break;
            if (!gridFiber) return null;
            const pending = [gridFiber];
            let visited = 0;
            while (pending.length && visited++ < 30000) {
                const fiber = pending.pop();
                if (fiber.sibling && fiber !== gridFiber) pending.push(fiber.sibling);
                if (fiber.child) pending.push(fiber.child);
                if (typeof fiber.type !== "function" || !fiber.memoizedProps) continue;
                const result = matchComponent(fiber);
                if (result !== undefined) return result;
            }
            return null;
        };

        const originalScrollTo = Element.prototype.scrollTo;
        const originalFocus = HTMLElement.prototype.focus;
        const originalScrollIntoView = Element.prototype.scrollIntoView;
        const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
            Element.prototype,
            "scrollTop",
        );

        let jumpAnimation = null;
        const cancelJumpAnimation = () => {
            if (jumpAnimation) {
                jumpAnimation.cancelled = true;
                jumpAnimation = null;
            }
        };

        const animateScrollTo = (scrollerElement, targetTop) => {
            cancelJumpAnimation();
            const thisAnimation = (jumpAnimation = { cancelled: false });
            const fromTop = scrollerElement.scrollTop,
                startTime = performance.now(),
                durationMs = Math.max(1, config.ANIM_MS);
            const frame = (now) => {
                if (thisAnimation.cancelled) return;
                const progress = Math.min(1, (now - startTime) / durationMs);
                originalScrollTo.call(scrollerElement, {
                    top: fromTop + (targetTop - fromTop) * (1 - Math.pow(1 - progress, 3)),
                    behavior: "instant",
                });
                if (progress < 1) requestAnimationFrame(frame);
                else if (jumpAnimation === thisAnimation) jumpAnimation = null;
            };
            requestAnimationFrame(frame);
        };


        let interceptedScroller = null;
        const interceptScrolling = (scrollerElement) => {
            if (interceptedScroller === scrollerElement) return;
            restoreScrolling();
            Object.defineProperty(scrollerElement, "scrollTop", {
                configurable: true,
                get() {
                    return originalScrollTopDescriptor.get.call(this);
                },
                set(value) {
                    state.scrollFocusCalls++;
                    if (state.swallowScroll) state.lastScrollTarget = value;
                    else originalScrollTopDescriptor.set.call(this, value);
                },
            });
            scrollerElement.scrollTo = function (options) {
                if (state.swallowScroll && options && typeof options.top === "number") {
                    state.scrollFocusCalls++;
                    state.lastScrollTarget = options.top;
                } else originalScrollTo.apply(this, arguments);
            };
            HTMLElement.prototype.focus = function (options) {
                if (scrollerElement.contains(this)) {
                    state.scrollFocusCalls++;
                    if (state.swallowScroll)
                        return originalFocus.call(this, {
                            ...(options || {}),
                            preventScroll: true,
                        });
                }
                return originalFocus.apply(this, arguments);
            };
            // Steam's focus handler also smooth-scrolls (~0 and ~370 ms after a step): ignore it during and just after a hold.
            Element.prototype.scrollIntoView = function () {
                if (
                    scrollerElement.contains(this) &&
                    (state.swallowScroll || performance.now() < state.ignoreScrollIntoViewUntil)
                )
                    return;
                return originalScrollIntoView.apply(this, arguments);
            };
            interceptedScroller = scrollerElement;
        };
        const restoreScrolling = () => {
            if (!interceptedScroller) return;
            delete interceptedScroller.scrollTop;
            delete interceptedScroller.scrollTo;
            HTMLElement.prototype.focus = originalFocus;
            Element.prototype.scrollIntoView = originalScrollIntoView;
            interceptedScroller = null;
        };

        // The grid is virtualised and can end up a few hundred px off after a long scroll, so re-snap shortly after a jump.
        const settleAfterJump = (scrollerElement, targetTop) => {
            const thisSettleId = ++state.settleId;
            const snapIfOff = () => {
                if (state.settleId !== thisSettleId || state.heldButton) return;
                const maxTop = Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight),
                    wantedTop = Math.min(maxTop, Math.max(0, targetTop));
                if (Math.abs(scrollerElement.scrollTop - wantedTop) > 2)
                    originalScrollTo.call(scrollerElement, { top: wantedTop, behavior: "instant" });
            };
            [config.ANIM_MS + 120, config.ANIM_MS + 500, config.ANIM_MS + 900].forEach((delay) =>
                setTimeout(snapIfOff, delay),
            );
        };

        const jumpToLastTarget = () => {
            const scrollerElement = getGridScroller();
            if (!scrollerElement || state.lastScrollTarget == null) return;
            if (
                !isAnimatorActive() &&
                Math.abs(state.lastScrollTarget - scrollerElement.scrollTop) > 1
            ) {
                animateScrollTo(scrollerElement, state.lastScrollTarget);
                settleAfterJump(scrollerElement, state.lastScrollTarget);
            }
        };

        // Steam clears the label ~100-160 ms after each step, which would flicker between our steps.
        let labelQueue = null,
            originalReducer = null,
            originalDispatch = null,
            wrappedDispatch = null;
        let labelActive = false,
            labelClearTimer = null,
            lastLabel = "",
            labelWatchFrame = null;

        const findLabelQueue = () =>
            findSteamGridHook((fiber) => {
                if (!("eSortBy" in fiber.memoizedProps)) return undefined;
                for (let hook = fiber.memoizedState, index = 0; hook && index < 60; hook = hook.next, index++)
                    if (
                        hook.queue &&
                        typeof hook.queue.dispatch === "function" &&
                        hook.queue.lastRenderedState === ""
                    )
                        return hook.queue;
                return undefined;
            });
        const setLabel = (text) => {
            if (originalDispatch) originalDispatch(text);
        };
        const currentLabel = () => (labelQueue ? labelQueue.lastRenderedState : "");

        const uninstallLabelGuard = () => {
            if (!labelQueue) return;
            try {
                delete labelQueue.lastRenderedReducer;
                labelQueue.lastRenderedReducer = originalReducer;
                if (labelQueue.dispatch === wrappedDispatch) labelQueue.dispatch = originalDispatch;
            } catch (e) {}
            labelQueue = null;
        };
        const installLabelGuard = () => {
            const queue = findLabelQueue();
            if (!queue || queue === labelQueue) return;
            uninstallLabelGuard();
            labelQueue = queue;
            originalReducer = queue.lastRenderedReducer;
            originalDispatch = queue.dispatch;
            wrappedDispatch = function (action) {
                if (action === "" && labelActive) return;
                return originalDispatch.apply(this, arguments);
            };
            queue.dispatch = wrappedDispatch;
            if (!state.heldButton) {
                // re-render once so Steam's closures pick up the wrapper before the first step
                originalDispatch(" ");
                originalDispatch("");
            }
            Object.defineProperty(queue, "lastRenderedReducer", {
                configurable: true,
                get() {
                    return (current, action) =>
                        action === "" && labelActive ? current : originalReducer(current, action);
                },
                set(value) {
                    originalReducer = value;
                },
            });
        };
        // Clears applied during render slip past the guards, so also re-assert the last label every frame.
        const watchLabel = () => {
            labelWatchFrame = null;
            if (!labelActive || !labelQueue) return;
            const current = labelQueue.lastRenderedState;
            if (current) lastLabel = current;
            else if (lastLabel) setLabel(lastLabel);
            labelWatchFrame = requestAnimationFrame(watchLabel);
        };
        const holdLabel = () => {
            if (!labelActive) lastLabel = "";
            labelActive = true;
            clearTimeout(labelClearTimer);
            if (!labelWatchFrame) labelWatchFrame = requestAnimationFrame(watchLabel);
        };
        const releaseLabel = () => {
            clearTimeout(labelClearTimer);
            labelClearTimer = setTimeout(() => {
                labelActive = false;
                lastLabel = "";
                setLabel("");
            }, config.OVERLAY_LINGER_MS);
        };

        // Learns which footer labels Steam hides on a step, then keeps them hidden until release.
        const footerTextsToHide = new Set();
        let footerObserver = null;
        const footerTexts = () => {
            const scrollerElement = getGridScroller();
            const leafElements = [...document.querySelectorAll("body *")].filter(
                (element) =>
                    element.children.length === 0 &&
                    element.textContent &&
                    element.textContent.trim().length < 20 &&
                    !(scrollerElement && scrollerElement.contains(element)) &&
                    element.getClientRects().length > 0,
            );
            return new Set(leafElements.map((element) => element.textContent.trim()));
        };
        const learnFooterLabelsToHide = (textsBeforeStep) =>
            setTimeout(() => {
                const textsNow = footerTexts();
                for (const text of textsBeforeStep)
                    if (!textsNow.has(text)) footerTextsToHide.add(text);
            }, 150);
        const hideLearnedFooterElements = () => {
            if (!state.heldButton) return;
            const scrollerElement = getGridScroller();
            for (const element of document.querySelectorAll("body *")) {
                const container = element.parentElement;
                if (
                    element.children.length !== 0 ||
                    !footerTextsToHide.has((element.textContent || "").trim()) ||
                    !container ||
                    container.hasAttribute("data-hj")
                )
                    continue;
                if (scrollerElement && scrollerElement.contains(element)) continue;
                container.setAttribute("data-hj", container.style.display || ""); // remembers the old value for showFooter
                container.style.display = "none";
            }
        };
        const hideFooter = () => {
            if (!footerTextsToHide.size || footerObserver) return;
            footerObserver = new MutationObserver(hideLearnedFooterElements);
            footerObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
            });
            hideLearnedFooterElements();
        };
        const showFooter = () => {
            if (footerObserver) {
                footerObserver.disconnect();
                footerObserver = null;
            }
            for (const element of document.querySelectorAll("[data-hj]")) {
                element.style.display = element.getAttribute("data-hj");
                element.removeAttribute("data-hj");
            }
        };

        // A useRef holding an object with End() and m_bActive.
        let animatorRef = null;
        const findAnimatorRef = () => {
            if (animatorRef) return animatorRef;
            return findSteamGridHook((fiber) => {
                if (!("childSections" in fiber.memoizedProps) || !("eSortBy" in fiber.memoizedProps))
                    return undefined;
                for (let hook = fiber.memoizedState, index = 0; hook && index < 80; hook = hook.next, index++) {
                    const ref = hook.memoizedState;
                    if (
                        ref &&
                        typeof ref === "object" &&
                        "current" in ref &&
                        Object.keys(ref).length === 1 &&
                        ref.current &&
                        typeof ref.current.End === "function" &&
                        "m_bActive" in ref.current
                    )
                        return (animatorRef = ref);
                }
                return undefined;
            });
        };
        const isAnimatorActive = () =>
            !!(animatorRef && animatorRef.current && animatorRef.current.m_bActive);
        const endAnimatorNow = () => {
            if (isAnimatorActive()) {
                try {
                    animatorRef.current.End();
                } catch (e) {}
            }
        };
        // Ending the animator soon after each step is what lets the next paced step be accepted (allows 150 ms steps).
        const endAnimatorSoon = () => {
            if (config.FAST_END_MS < 0) return;
            const ref = findAnimatorRef();
            if (!ref || !ref.current) return;
            const animator = ref.current;
            setTimeout(() => {
                try {
                    if (ref.current === animator && animator.m_bActive) animator.End();
                } catch (e) {}
            }, config.FAST_END_MS);
        };

        // Fills Steam's section/item refs (undefined after a sort change) from the focused tile, so Steam can see boundaries.
        const primeSteamPositionRefs = () =>
            findSteamGridHook((fiber) => {
                if (!("childSections" in fiber.memoizedProps) || !("eSortBy" in fiber.memoizedProps))
                    return undefined;
                const hook0 = fiber.memoizedState,
                    hook1 = hook0 && hook0.next,
                    hook2 = hook1 && hook1.next;
                if (!hook2) return undefined;
                const sectionRef = hook0.memoizedState,
                    itemRef = hook1.memoizedState,
                    tileMap = hook2.memoizedState;
                const looksRight =
                    sectionRef &&
                    typeof sectionRef === "object" &&
                    "current" in sectionRef &&
                    itemRef &&
                    typeof itemRef === "object" &&
                    "current" in itemRef &&
                    tileMap &&
                    tileMap.current &&
                    typeof tileMap.current.entries === "function" &&
                    typeof tileMap.current.get === "function" &&
                    "size" in tileMap.current;
                if (!looksRight) return undefined;
                if (sectionRef.current !== undefined && itemRef.current !== undefined) return true;
                for (const [key, tileNavRef] of tileMap.current) {
                    let hasFocus = false;
                    try {
                        hasFocus = !!(
                            tileNavRef &&
                            typeof tileNavRef.BHasFocus === "function" &&
                            tileNavRef.BHasFocus()
                        );
                    } catch (e) {}
                    const match = /^(\d+)_(\d+)$/.exec(key);
                    if (hasFocus && match) {
                        sectionRef.current = +match[1];
                        itemRef.current = +match[2];
                        return true;
                    }
                }
                return false; // no focused tile to copy from
            });

        // Re-fires the press for Steam's own handler to step. Returns true if the step was accepted.
        const dispatchSteamStep = (detail, fallbackTarget, synchronous) => {
            const scrollerElement = getGridScroller();
            if (!scrollerElement) return false;
            interceptScrolling(scrollerElement);
            installLabelGuard();
            holdLabel();
            state.swallowScroll = true;
            const callsBefore = state.scrollFocusCalls,
                animatorWasActive = isAnimatorActive();
            if (state.heldButton && !state.hasStepped) {
                state.hasStepped = true;
                if (!footerTextsToHide.size) learnFooterLabelsToHide(footerTexts());
            }
            const target =
                document.activeElement && scrollerElement.contains(document.activeElement)
                    ? document.activeElement
                    : fallbackTarget;
            const pressEvent = new CustomEvent("vgp_onbuttondown", {
                bubbles: true,
                cancelable: true,
                composed: true,
                detail: { ...detail, is_repeat: false },
            });
            pressEvent.isOurOwnStep = true;
            target.dispatchEvent(pressEvent);
            // defaultPrevented: Steam took the press, as a real step or a refusal at a boundary (false = sort has no stepping)
            state.steamHandledPress = pressEvent.defaultPrevented;
            const animator = findAnimatorRef();
            const startedAnimator = !!(
                animator &&
                animator.current &&
                animator.current.m_bActive &&
                !animatorWasActive
            );
            state.animatorWasActive = animatorWasActive;
            if (synchronous) {
                if (startedAnimator) {
                    try {
                        animator.current.End();
                    } catch (e) {}
                }
            } else endAnimatorSoon();
            return state.scrollFocusCalls !== callsBefore || startedAnimator;
        };
        // A step counts as accepted if Steam scrolled/focused during the dispatch, or its label changed shortly after.
        const tryStep = (detail, target, done) => {
            const labelBefore = currentLabel();
            if (dispatchSteamStep(detail, target)) return done(true);
            setTimeout(() => {
                const labelAfter = currentLabel();
                done(!!labelAfter && labelAfter !== labelBefore);
            }, config.LABEL_CHECK_MS);
        };

        const stopRepeating = () => {
            clearTimeout(state.repeatTimer);
            state.repeatTimer = null;
            state.heldButton = null;
        };
        // Repeats steps while held; stops once Steam keeps refusing (end of list).
        const scheduleRepeat = (detail, target, isFirstRepeat, timeSpentMs) => {
            const intervalMs = isFirstRepeat ? config.HOLD_DELAY_MS : config.START_INTERVAL_MS;
            const scheduledAt = performance.now();
            const attempt = () => {
                if (!state.heldButton) return;
                const attemptStartedAt = performance.now();
                tryStep(detail, target, (accepted) => {
                    if (!state.heldButton) return;
                    if (accepted) {
                        scheduleRepeat(detail, target, false, performance.now() - attemptStartedAt);
                        return;
                    }
                    if (performance.now() - scheduledAt > intervalMs + config.GIVE_UP_MS) return;
                    state.repeatTimer = setTimeout(attempt, config.RETRY_MS);
                });
            };
            state.repeatTimer = setTimeout(attempt, Math.max(0, intervalMs - (timeSpentMs || 0)));
        };

        // Steps the opposite way until Steam refuses (the far end), then jumps there once.
        const wrapAround = (button, target) => {
            const oppositeButton = button === config.BTN_R2 ? config.BTN_L2 : config.BTN_R2;
            let steps = 0;
            while (steps < 300 && dispatchSteamStep({ button: oppositeButton }, target, true)) steps++;
            if (!steps) {
                state.swallowScroll = false;
                return false;
            }
            hideFooter();
            setTimeout(() => {
                showFooter();
                state.swallowScroll = false;
                state.ignoreScrollIntoViewUntil = performance.now() + 500;
                releaseLabel();
                jumpToLastTarget();
            }, 40);
            return true;
        };

        const isInsideGrid = (event) => {
            const scrollerElement = getGridScroller();
            return (
                scrollerElement &&
                event.target instanceof Node &&
                scrollerElement.contains(event.target)
            );
        };
        const isTriggerButton = (button) => button === config.BTN_R2 || button === config.BTN_L2;

        const onButtonDown = (event) => {
            if (event.isOurOwnStep) return;
            const button = event.detail && event.detail.button;
            if (!isTriggerButton(button)) return;
            if (!state.heldButton && !isInsideGrid(event)) return;
            event.stopImmediatePropagation();
            event.preventDefault(); // Steam's native handler must not also run
            if (event.detail.is_repeat || state.heldButton) return;
            try {
                primeSteamPositionRefs();
            } catch (error) {}
            state.heldButton = button;
            state.lastScrollTarget = null;
            state.hasStepped = false;
            state.steamHandledPress = false;
            const detail = { button };
            const target = event.target;
            tryStep(detail, target, (accepted) => {
                if (state.heldButton !== button) return;
                if (!accepted) {
                    // Wrap only if Steam refused at a boundary, nothing was animating, and no hold just ended at the end.
                    const canWrap =
                        config.WRAP_ON_TAP &&
                        state.steamHandledPress &&
                        !state.animatorWasActive &&
                        performance.now() - state.lastReleaseAt > config.WRAP_MIN_GAP_MS;
                    stopRepeating();
                    showFooter();
                    state.swallowScroll = false;
                    if (canWrap) {
                        state.lastScrollTarget = null;
                        wrapAround(button, target);
                    }
                    return;
                }
                hideFooter(); // only once Steam really stepped, so a refused press never touches the footer
                scheduleRepeat(detail, target, true);
            });
        };

        const onButtonUp = (event) => {
            const button = event.detail && event.detail.button;
            if (!isTriggerButton(button)) return;
            state.lastReleaseAt = performance.now();
            if (state.heldButton !== button) return;
            event.stopImmediatePropagation();
            stopRepeating();
            showFooter();
            // Commit a step still animating while scrolls are swallowed, then release one tick later and jump once.
            endAnimatorNow();
            state.ignoreScrollIntoViewUntil = performance.now() + 600;
            clearTimeout(state.releaseTimer);
            state.releaseTimer = setTimeout(() => {
                if (state.heldButton) return; // a new press already started
                state.swallowScroll = false;
                state.ignoreScrollIntoViewUntil = performance.now() + 500;
                releaseLabel();
                jumpToLastTarget();
            }, 30);
        };

        // The grid is rebuilt on sort change or remount, so keep the label guard on the current one.
        const guardRefreshTimer = setInterval(() => {
            if (!state.heldButton && getGridScroller()) installLabelGuard();
        }, 1000);
        installLabelGuard();
        window.addEventListener("vgp_onbuttondown", onButtonDown, true); // capture: runs before Steam's handlers
        window.addEventListener("vgp_onbuttonup", onButtonUp, true);
        window.libraryJump = {
            config,
            state,
            label: () => (labelQueue ? labelQueue.lastRenderedState : null),
            undo() {
                window.removeEventListener("vgp_onbuttondown", onButtonDown, true);
                window.removeEventListener("vgp_onbuttonup", onButtonUp, true);
                clearInterval(guardRefreshTimer);
                animatorRef = null;
                stopRepeating();
                showFooter();
                state.swallowScroll = false;
                cancelJumpAnimation();
                clearTimeout(labelClearTimer);
                labelActive = false;
                if (labelWatchFrame) cancelAnimationFrame(labelWatchFrame);
                setLabel("");
                uninstallLabelGuard();
                restoreScrolling();
                delete window.libraryJump;
                return "undone (bpm)";
            },
        };
        return "installed";
    })();
}
