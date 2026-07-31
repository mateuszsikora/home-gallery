import { createRoot } from 'react-dom/client';

import { createHomeGalleryClient } from '@home-gallery/api-client';

import { Gallery } from './gallery.js';
import './styles.css';

const apiBaseUrl =
  import.meta.env.VITE_HOME_GALLERY_API_URL?.trim() || window.location.origin;
const root = document.querySelector<HTMLElement>('#root');

if (root === null) {
  throw new Error('Gallery root element is missing');
}

createRoot(root).render(
  <Gallery
    apiBaseUrl={apiBaseUrl}
    client={createHomeGalleryClient({ baseUrl: apiBaseUrl })}
  />,
);
