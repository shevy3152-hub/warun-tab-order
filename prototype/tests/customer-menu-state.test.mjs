import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerMenuState, customerMenuStateReducer } from "../src/customer-menu-state.js";

test("initial menu request uses the loading state", () => {
  const initial = createCustomerMenuState(true);
  assert.deepEqual(initial, { menu: null, loading: true, error: false });
  assert.deepEqual(customerMenuStateReducer(initial, { type: "load-failed" }), { menu: null, loading: false, error: true });
});

test("reconnect refetch retains the current menu until a successful response replaces it", () => {
  const firstMenu = { items: [{ id: "old-item", imageUri: "/old.webp" }] };
  const updatedMenu = { items: [{ id: "new-item", imageUri: "/new.webp" }] };
  let state = customerMenuStateReducer(createCustomerMenuState(true), { type: "load-succeeded", menu: firstMenu });

  state = customerMenuStateReducer(state, { type: "load-started" });
  assert.equal(state.loading, false);
  assert.equal(state.menu, firstMenu);

  state = customerMenuStateReducer(state, { type: "load-succeeded", menu: updatedMenu });
  assert.equal(state.menu, updatedMenu);
  assert.equal(state.loading, false);
  assert.equal(state.error, false);
});

test("a transient menu request failure preserves existing items and images", () => {
  const loadedMenu = { items: [{ id: "still-visible", imageUri: "/kept.webp" }] };
  let state = customerMenuStateReducer(createCustomerMenuState(true), { type: "load-succeeded", menu: loadedMenu });
  state = customerMenuStateReducer(state, { type: "load-started" });
  state = customerMenuStateReducer(state, { type: "load-failed" });

  assert.equal(state.menu, loadedMenu);
  assert.equal(state.menu.items[0].imageUri, "/kept.webp");
  assert.equal(state.loading, false);
  assert.equal(state.error, true);
});
