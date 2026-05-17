import * as SecureStore from 'expo-secure-store';
export const getItem = (key: string) => SecureStore.getItemAsync(key);
export const setItem = (key: string, value: string) => SecureStore.setItemAsync(key, value);
export const deleteItem = (key: string) => SecureStore.deleteItemAsync(key);
