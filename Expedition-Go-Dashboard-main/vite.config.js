import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { visualizer } from 'rollup-plugin-visualizer'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production';

  return {
    plugins: [
      react(),
      // Bundle analyzer - generates stats.html
      isProduction && visualizer({
        filename: './dist/stats.html',
        open: false,
        gzipSize: true,
        brotliSize: true,
      }),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    
    // Build configuration
    build: {
      // Generate sourcemaps for production debugging
      sourcemap: isProduction ? 'hidden' : true,
      
      // Output directory
      outDir: 'dist',
      
      // Minification
      minify: isProduction ? 'terser' : false,
      
      // Terser options for better minification
      terserOptions: isProduction ? {
        compress: {
          drop_console: true, // Remove console.logs in production
          drop_debugger: true,
        },
      } : {},
      
      // Chunk size warnings
      chunkSizeWarningLimit: 1000,
      
      // Rollup options for code splitting
      rollupOptions: {
        output: {
          // Manual chunks for better caching
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
                return 'react-vendor';
              }
              if (id.includes('lucide-react') || id.includes('sonner')) {
                return 'ui-vendor';
              }
              if (id.includes('react-hook-form') || id.includes('zod') || id.includes('@hookform')) {
                return 'form-vendor';
              }
              if (id.includes('zustand')) {
                return 'state-vendor';
              }
              return 'vendor';
            }
          },
          
          // Asset file names
          assetFileNames: (assetInfo) => {
            if (!assetInfo.name) return 'assets/[name]-[hash][extname]';
            
            const info = assetInfo.name.split('.');
            let extType = info[info.length - 1];
            
            if (/\.(png|jpe?g|svg|gif|tiff|bmp|ico)$/i.test(assetInfo.name)) {
              extType = 'images';
            } else if (/\.(woff2?|eot|ttf|otf)$/i.test(assetInfo.name)) {
              extType = 'fonts';
            }
            
            return `assets/${extType}/[name]-[hash][extname]`;
          },
          
          // Chunk file names
          chunkFileNames: 'assets/js/[name]-[hash].js',
          
          // Entry file names
          entryFileNames: 'assets/js/[name]-[hash].js',
        },
      },
      
      // Asset optimization
      assetsInlineLimit: 4096, // 4kb - inline assets smaller than this
    },
    
    // Server configuration
    server: {
      port: 5173,
      strictPort: false,
      host: true,
      open: false,
    },
    
    // Preview configuration
    preview: {
      port: 4173,
      strictPort: false,
      host: true,
      open: false,
    },
    
    // Dependency optimization
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-router-dom',
        'zustand',
        'axios',
        'lucide-react',
        'sonner',
        'react-hook-form',
        'zod',
      ],
    },
  };
});
