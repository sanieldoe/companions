export const getItem = async (key: string) => localStorage.getItem(key);
export const setItem = async (key: string, value: string) => { localStorage.setItem(key, value); };
export const deleteItem = async (key: string) => { localStorage.removeItem(key); };
