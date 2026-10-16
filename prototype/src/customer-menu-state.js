export function createCustomerMenuState(initialLoading = false) {
  return { menu: null, loading: initialLoading, error: false };
}

export function customerMenuStateReducer(state, action) {
  switch (action?.type) {
    case "load-started":
      return { ...state, loading: state.menu === null, error: false };
    case "load-succeeded":
      return { menu: action.menu, loading: false, error: false };
    case "load-failed":
      return { ...state, loading: false, error: true };
    default:
      return state;
  }
}
