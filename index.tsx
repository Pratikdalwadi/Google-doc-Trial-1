/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from '@google/genai';

// Fix: Declare pdfjsLib to resolve "Cannot find name 'pdfjsLib'" error.
declare var pdfjsLib: any;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const fileUpload = document.getElementById('file-upload') as HTMLInputElement;
const fileNameSpan = document.getElementById('file-name');
const uploadError = document.getElementById('upload-error') as HTMLSpanElement;
const extractButton = document.getElementById(
  'extract-button',
) as HTMLButtonElement;
const markdownResultsContainer = document.getElementById('markdown-results');
const jsonResultsContainer = document.getElementById('json-results');
const loadingSpinner = document.getElementById('loading-spinner');
const previewContainer = document.getElementById('preview-container');
const tabsContainer = document.querySelector('.tabs');
const tabButtons = document.querySelectorAll('.tab-button');
const tabPanels = document.querySelectorAll('.tab-panel');
const exportButton = document.getElementById(
  'export-button',
) as HTMLButtonElement;
const exportDropdown = document.getElementById('export-dropdown');
const exportCsvButton = document.getElementById('export-csv');
const exportTxtButton = document.getElementById('export-txt');

let file: File | null = null;
let fileData: {
  mimeType: string;
  data: string;
} | null = null;
let pageDimensions: { width: number; height: number }[] = [];
let extractedData: any[] = [];
let isThrottled = false;
let lastHoveredElementIndex = -1;

// The schema is now a constant to be used for both the API call and the UI display.
const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    extracted_elements: {
      type: Type.ARRAY,
      description: 'An array of all elements extracted from the document.',
      items: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            description:
              "The type of element. Must be one of: 'field', 'field_group', 'table', 'paragraph', 'checkbox', 'logo', 'figure', 'marginalia', 'attestation'.",
          },
          label: {
            type: Type.STRING,
            description:
              'The label or key for a field, or a title for a table/paragraph.',
          },
          value: {
            type: Type.STRING,
            description:
              "The extracted text value or a description for visual elements. Not used for 'table' or 'field_group' types.",
          },
          page: {
            type: Type.INTEGER,
            description:
              'The page number where the element was found (starting from 1).',
          },
          bounding_box: {
            type: Type.OBJECT,
            properties: {
              left: { type: Type.NUMBER },
              top: { type: Type.NUMBER },
              right: { type: Type.NUMBER },
              bottom: { type: Type.NUMBER },
            },
            description:
              "Normalized coordinates of the element's bounding box, with {left, top, right, bottom} properties. The origin (0,0) is the top-left corner of the page. For a 'field_group', this should encompass all fields in the group.",
          },
          line_boxes: {
            type: Type.ARRAY,
            description:
              'For multi-line text elements, an array of bounding boxes for each individual text line to allow for a tighter visual fit. Each box MUST be in the {left, top, right, bottom} format.',
            items: {
              type: Type.OBJECT,
              properties: {
                left: { type: Type.NUMBER },
                top: { type: Type.NUMBER },
                right: { type: Type.NUMBER },
                bottom: { type: Type.NUMBER },
              },
            },
          },
          table_data: {
            type: Type.OBJECT,
            description:
              "Contains header and row data. Only present if type is 'table'.",
            properties: {
              headers: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'The column headers of the table.',
              },
              rows: {
                type: Type.ARRAY,
                items: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    "An array of strings representing a single row's cells.",
                },
                description: 'The data rows of the table.',
              },
            },
          },
          fields: {
            type: Type.ARRAY,
            description:
              "An array of individual fields. Only present if type is 'field_group'.",
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
  },
};

// --- Event Listeners ---

fileUpload.addEventListener('change', async (event) => {
  const target = event.target as HTMLInputElement;
  if (target.files && target.files[0]) {
    const selectedFile = target.files[0];
    const supportedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ];

    if (!supportedTypes.includes(selectedFile.type)) {
      uploadError.textContent =
        'Unsupported file type. Please upload a PDF or an image.';
      uploadError.classList.remove('hidden');
      // Reset state
      fileUpload.value = '';
      fileNameSpan.textContent = 'No file chosen';
      extractButton.disabled = true;
      file = null;
      return;
    }

    uploadError.classList.add('hidden'); // Hide error if file is valid
    file = selectedFile;
    fileNameSpan.textContent = file.name;
    extractButton.disabled = false;
    await renderPreview(file);
  } else {
    fileNameSpan.textContent = 'No file chosen';
    extractButton.disabled = true;
    clearPreview();
  }
});

extractButton.addEventListener('click', async () => {
  if (!file || !fileData) return;

  loadingSpinner.classList.remove('hidden');
  clearResults();
  clearBoundingBoxes();

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            text: `You are an Agentic Document Extraction system. Your primary goal is to perform a comprehensive analysis of the uploaded document and return structured, accurate data with intelligent grouping and precise visual traceability.

**Core Instructions:**
1.  **Intelligent Grouping (Highest Priority):** You MUST actively identify and group logically related fields into a \`field_group\`. This is crucial for creating a clean, organized, and human-readable output. Examples of good grouping include:
    -   Patient Information (Name, DOB, Age, etc.)
    -   Provider Information (Name, Address, Phone, etc.)
    -   An entire address block (street, city, state, zip).
    Always prefer grouping over listing individual fields when a logical connection exists.
2.  **Comprehensive Extraction:** You must extract ALL data from the document. Leave nothing out.
3.  **Sequential Ordering:** The elements in the final 'extracted_elements' array must be sorted to strictly follow the top-to-bottom reading order of the source document.
4.  **Precise Bounding Box Coordinates:** For every element, you MUST provide coordinates in a **normalized {left, top, right, bottom} format**.
    - The origin (0,0) is the top-left corner of the page.
    - \`left\`: The distance from the left edge of the page to the left edge of the box (0.0 to 1.0).
    - \`top\`: The distance from the top edge of the page to the top edge of the box (0.0 to 1.0).
    - \`right\`: The distance from the left edge of the page to the right edge of the box (0.0 to 1.0).
    - \`bottom\`: The distance from the top edge of the page to the bottom edge of the box (0.0 to 1.0).
    - Provide up to 5 decimal places for precision.
5.  **Granular Line Boxes for Tighter Fit:** For any element containing text that visibly spans multiple lines on the document (e.g., 'paragraph', long 'field' values), you MUST ALSO provide a 'line_boxes' array. Each item in this array should be a precise bounding box for a single line of text, also in the {left, top, right, bottom} format. This is crucial for creating a tight visual highlight.
6.  **Element Categorization:** Classify each extracted element into one of the following types: 'field', 'field_group', 'table', 'paragraph', 'checkbox', 'logo', 'figure', 'marginalia', 'attestation'.

**Type-Specific Instructions:**
-   **field_group:** This is the preferred way to organize data. Use it liberally for sets of logically related fields. The 'bounding_box' for a group MUST encompass all of its child fields. Provide a clear and descriptive 'label' for the group (e.g., "Patient Information").
-   **field:** A simple key-value pair. Use this ONLY for individual fields that do not logically belong to any larger group. If the 'value' spans multiple lines, populate the 'line_boxes' array.
-   **paragraph:** A block of free-form text. If it spans multiple lines, you MUST populate the 'line_boxes' array.
-   **table:** Structured data in rows and columns. Populate the 'table_data' object.
-   **logo / figure:** For visual elements like logos or images, set the type accordingly and provide a detailed description of the visual content in the 'value' field.
-   **marginalia:** Text outside the main content block, like page numbers or headers/footers.
-   **attestation:** Signature blocks or electronic signature confirmations.

The output must be a single, valid JSON object that strictly adheres to the provided schema, with no additional text or explanations.`,
          },
          {
            inlineData: fileData,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    const parsedResult = JSON.parse(response.text);
    extractedData = parsedResult.extracted_elements || [];
    displayMarkdownResults(extractedData);
    displayJsonResults(parsedResult);
    exportButton.disabled = extractedData.length === 0;
    setActiveTab('markdown');
  } catch (error) {
    console.error('Error extracting data:', error);
    markdownResultsContainer.innerHTML = `
    <div class="error-panel">
      <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>
      <div>
        <strong>Extraction Failed</strong>
        <p>The model could not process the document. This can happen with complex layouts, handwritten text, or low-quality scans. Please try again with a clearer document.</p>
      </div>
    </div>`;
    setActiveTab('markdown');
    extractedData = [];
    exportButton.disabled = true;
  } finally {
    loadingSpinner.classList.add('hidden');
  }
});

tabsContainer.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('tab-button')) {
    const tabName = target.dataset.tab;
    // Fix: Ensure tabName is a string before calling setActiveTab, which requires a string argument.
    if (tabName) {
      setActiveTab(tabName);
    }
  }
});

exportButton.addEventListener('click', () => {
  exportDropdown.classList.toggle('hidden');
});

exportCsvButton.addEventListener('click', (e) => {
  e.preventDefault();
  if (extractedData.length > 0) {
    exportAsCsv(extractedData);
  }
  exportDropdown.classList.add('hidden');
});

exportTxtButton.addEventListener('click', (e) => {
  e.preventDefault();
  if (extractedData.length > 0) {
    exportAsTxt(extractedData);
  }
  exportDropdown.classList.add('hidden');
});

// Close dropdown if clicked outside
document.addEventListener('click', (event) => {
  if (
    !exportButton.contains(event.target as Node) &&
    !exportDropdown.contains(event.target as Node)
  ) {
    exportDropdown.classList.add('hidden');
  }
});

previewContainer.addEventListener('mousemove', (event) => {
  handlePreviewMouseMove(event);
});

previewContainer.addEventListener('mouseleave', () => {
  clearBoundingBoxes();
  lastHoveredElementIndex = -1;
});

// --- UI Functions ---

function setActiveTab(tabName: string) {
  tabButtons.forEach((button) => {
    // Fix: Cast 'button' to HTMLElement to access the 'dataset' property.
    // This resolves the "Property 'dataset' does not exist on type 'Element'" error,
    // as querySelectorAll returns a list of generic Elements.
    button.classList.toggle(
      'active',
      (button as HTMLElement).dataset.tab === tabName,
    );
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `${tabName}-tab`);
  });
}

async function renderPreview(file: File) {
  clearPreview();
  const reader = new FileReader();

  reader.onload = async (e) => {
    const result = e.target.result as string;
    const base64Data = result.split(',')[1];
    fileData = {
      mimeType: file.type,
      data: base64Data,
    };

    if (file.type === 'application/pdf') {
      const pdf = await pdfjsLib.getDocument({ data: atob(base64Data) })
        .promise;

      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = document.createElement('canvas');
        canvas.dataset.pageNumber = String(i);

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        pageDimensions.push({
          width: viewport.width,
          height: viewport.height,
        });

        await page.render({ canvasContext: context, viewport: viewport })
          .promise;
        previewContainer.appendChild(canvas);
      }
    } else {
      const imagePreview = document.createElement('img');
      imagePreview.src = result;
      imagePreview.alt = 'Image preview';
      imagePreview.dataset.pageNumber = '1';

      imagePreview.onload = () => {
        pageDimensions.push({
          width: imagePreview.naturalWidth,
          height: imagePreview.naturalHeight,
        });
      };
      previewContainer.appendChild(imagePreview);
    }
  };
  reader.readAsDataURL(file);
}

function displayMarkdownResults(elements: any[]) {
  markdownResultsContainer.innerHTML = ''; // Clear previous results
  if (!elements || elements.length === 0) {
    markdownResultsContainer.innerHTML =
      '<p>No structured data was extracted. The document might be empty or in an unsupported format.</p>';
    return;
  }

  elements.forEach((element, index) => {
    const resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    resultItem.dataset.elementIndex = String(index);
    resultItem.addEventListener('mouseover', () => drawBoundingBox(element));
    resultItem.addEventListener('mouseout', clearBoundingBoxes);

    switch (element.type) {
      case 'field':
      case 'checkbox':
      case 'paragraph':
      case 'logo':
      case 'figure':
      case 'marginalia':
      case 'attestation':
        resultItem.classList.add('field-item', `${element.type}-item`);
        resultItem.innerHTML = `
          <span class="result-label">${element.label || element.type}</span>
          <span class="result-value">${element.value || 'N/A'}</span>
        `;
        break;

      case 'field_group':
        resultItem.classList.add('field-group-item');
        const groupTitle = document.createElement('h3');
        groupTitle.textContent = element.label || 'Field Group';
        resultItem.appendChild(groupTitle);

        if (element.fields && element.fields.length > 0) {
          const fieldsList = document.createElement('div');
          fieldsList.className = 'field-group-fields';
          element.fields.forEach(
            (field: { label: string; value: string }) => {
              const fieldDiv = document.createElement('div');
              fieldDiv.className = 'field-item-inner';
              fieldDiv.innerHTML = `
                <span class="result-label">${field.label || 'N/A'}</span>
                <span class="result-value">${field.value || 'N/A'}</span>
              `;
              fieldsList.appendChild(fieldDiv);
            },
          );
          resultItem.appendChild(fieldsList);
        }
        break;

      case 'table':
        resultItem.classList.add('table-item');
        const tableTitle = document.createElement('h3');
        tableTitle.textContent = element.label || 'Extracted Table';
        resultItem.appendChild(tableTitle);

        if (element.table_data && element.table_data.rows) {
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');

          (element.table_data.headers || []).forEach((headerText: string) => {
            const th = document.createElement('th');
            th.textContent = headerText;
            headerRow.appendChild(th);
          });
          thead.appendChild(headerRow);
          table.appendChild(thead);

          const tbody = document.createElement('tbody');
          element.table_data.rows.forEach((rowData: string[]) => {
            const row = document.createElement('tr');
            rowData.forEach((cellData: string) => {
              const td = document.createElement('td');
              td.textContent = cellData;
              row.appendChild(td);
            });
            tbody.appendChild(row);
          });
          table.appendChild(tbody);
          resultItem.appendChild(table);
        } else {
          resultItem.innerHTML += '<p>Table data is empty or malformed.</p>';
        }
        break;

      default:
        return; // Skip unknown types
    }
    markdownResultsContainer.appendChild(resultItem);
  });
}

function displayJsonResults(data: any) {
  jsonResultsContainer.textContent = JSON.stringify(data, null, 2);
}

function drawBoundingBox(element: any) {
  clearBoundingBoxes();

  // Prioritize using granular line_boxes for a tighter fit,
  // otherwise fall back to the main bounding_box.
  const boxesToDraw =
    element.line_boxes && element.line_boxes.length > 0
      ? element.line_boxes
      : element.bounding_box
        ? [element.bounding_box]
        : [];

  if (boxesToDraw.length === 0 || !element.page) return;

  const previewElement = document.querySelector(
    `#preview-container [data-page-number='${element.page}']`,
  ) as HTMLElement;

  if (!previewElement) return;

  // Scroll the element into view once before drawing any boxes.
  previewElement.scrollIntoView({
    behavior: 'auto',
    block: 'center',
  });

  // Calculate scaling and offset details once.
  const displayWidth = previewElement.clientWidth;
  const displayHeight = previewElement.clientHeight;

  const { width: contentWidth, height: contentHeight } =
    pageDimensions[element.page - 1];

  if (!contentWidth || !contentHeight) return;

  const displayAspectRatio = displayWidth / displayHeight;
  const contentAspectRatio = contentWidth / contentHeight;

  let scale: number;
  let offsetX = 0;
  let offsetY = 0;

  if (displayAspectRatio > contentAspectRatio) {
    scale = displayHeight / contentHeight;
    const scaledContentWidth = contentWidth * scale;
    offsetX = (displayWidth - scaledContentWidth) / 2;
  } else {
    scale = displayWidth / contentWidth;
    const scaledContentHeight = contentHeight * scale;
    offsetY = (displayHeight - scaledContentHeight) / 2;
  }

  const containerRect = previewContainer.getBoundingClientRect();
  const elementRect = previewElement.getBoundingClientRect();

  const relativeTop =
    elementRect.top - containerRect.top + previewContainer.scrollTop;
  const relativeLeft =
    elementRect.left - containerRect.left + previewContainer.scrollLeft;

  // Draw a div for each box.
  boxesToDraw.forEach((box: any) => {
    if (!box) return;

    const boundingBoxDiv = document.createElement('div');
    boundingBoxDiv.className = 'bounding-box';

    if (element.type === 'figure' || element.type === 'logo') {
      boundingBoxDiv.classList.add('bounding-box-visual');
    } else {
      boundingBoxDiv.classList.add('bounding-box-text');
    }

    const boxX = box.left * contentWidth * scale + offsetX;
    const boxY = box.top * contentHeight * scale + offsetY;
    const boxWidth = (box.right - box.left) * contentWidth * scale;
    const boxHeight = (box.bottom - box.top) * contentHeight * scale;

    boundingBoxDiv.style.left = `${relativeLeft + boxX}px`;
    boundingBoxDiv.style.top = `${relativeTop + boxY}px`;
    boundingBoxDiv.style.width = `${boxWidth}px`;
    boundingBoxDiv.style.height = `${boxHeight}px`;

    previewContainer.appendChild(boundingBoxDiv);
  });
}

function clearBoundingBoxes() {
  const existingBoxes = document.querySelectorAll('.bounding-box');
  existingBoxes.forEach((box) => box.remove());

  const highlightedItems = document.querySelectorAll('.result-item.highlighted');
  highlightedItems.forEach((item) => item.classList.remove('highlighted'));
}

function clearResults() {
  markdownResultsContainer.innerHTML = '';
  jsonResultsContainer.textContent = '';
  extractedData = [];
  exportButton.disabled = true;
}

function clearPreview() {
  previewContainer.innerHTML = '';
  fileData = null;
  pageDimensions = [];
  clearBoundingBoxes();
  clearResults();
  setActiveTab('schema');
  uploadError.classList.add('hidden');
}

function handlePreviewMouseMove(event: MouseEvent) {
  if (isThrottled || !extractedData || extractedData.length === 0) return;
  isThrottled = true;
  setTimeout(() => (isThrottled = false), 50); // throttle calls

  const target = event.target as HTMLElement;
  // Clear highlights if cursor is not over a page (e.g., in the padding)
  if (!target || !['CANVAS', 'IMG'].includes(target.tagName)) {
    if (lastHoveredElementIndex !== -1) {
      clearBoundingBoxes();
      lastHoveredElementIndex = -1;
    }
    return;
  }

  const pageEl = target;
  const pageNum = parseInt(pageEl.dataset.pageNumber, 10);
  const pageDim = pageDimensions[pageNum - 1];
  if (!pageDim) return;

  const { width: contentWidth, height: contentHeight } = pageDim;
  const displayWidth = pageEl.clientWidth;
  const displayHeight = pageEl.clientHeight;

  const displayAspectRatio = displayWidth / displayHeight;
  const contentAspectRatio = contentWidth / contentHeight;

  let scale: number;
  let offsetX = 0;
  let offsetY = 0;
  if (displayAspectRatio > contentAspectRatio) {
    scale = displayHeight / contentHeight;
    offsetX = (displayWidth - contentWidth * scale) / 2;
  } else {
    scale = displayWidth / contentWidth;
    offsetY = (displayHeight - contentHeight * scale) / 2;
  }

  // event.offsetX/Y are relative to the target element (the canvas/image)
  const normalizedX = (event.offsetX - offsetX) / (contentWidth * scale);
  const normalizedY = (event.offsetY - offsetY) / (contentHeight * scale);

  let foundElementIndex = -1;
  // Iterate backwards to find the topmost element (last in the DOM order)
  for (let i = extractedData.length - 1; i >= 0; i--) {
    const element = extractedData[i];
    if (element.page !== pageNum) continue;

    const boxesToCheck =
      element.line_boxes && element.line_boxes.length > 0
        ? element.line_boxes
        : element.bounding_box
          ? [element.bounding_box]
          : [];

    for (const box of boxesToCheck) {
      if (
        box &&
        normalizedX >= box.left &&
        normalizedX <= box.right &&
        normalizedY >= box.top &&
        normalizedY <= box.bottom
      ) {
        foundElementIndex = i;
        break;
      }
    }
    if (foundElementIndex !== -1) break;
  }

  if (foundElementIndex !== lastHoveredElementIndex) {
    clearBoundingBoxes();
    if (foundElementIndex !== -1) {
      const element = extractedData[foundElementIndex];
      drawBoundingBox(element);
      const resultItem = markdownResultsContainer.querySelector(
        `[data-element-index='${foundElementIndex}']`,
      );
      if (resultItem) {
        resultItem.classList.add('highlighted');
        resultItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    lastHoveredElementIndex = foundElementIndex;
  }
}

// --- Export Functions ---
// Note: These are simplified implementations.
function exportAsCsv(data: any[]) {
  const headers = ['type', 'label', 'value', 'page'];
  let csvRows = [headers.join(',')];

  data.forEach((element) => {
    if (element.type === 'field_group' && element.fields) {
      element.fields.forEach((field: { label: string; value: string }) => {
        const row = [
          'field',
          `"${element.label} - ${field.label}"`,
          `"${field.value}"`,
          element.page,
        ].join(',');
        csvRows.push(row);
      });
    } else if (element.type === 'table' && element.table_data) {
      const tableHeader = element.table_data.headers.join(' | ');
      element.table_data.rows.forEach((tableRow: string[]) => {
        const row = [
          'table_row',
          `"${element.label} (${tableHeader})"`,
          `"${tableRow.join(' | ')}"`,
          element.page,
        ].join(',');
        csvRows.push(row);
      });
    } else {
      const row = [
        element.type,
        `"${element.label || ''}"`,
        `"${element.value || ''}"`,
        element.page,
      ].join(',');
      csvRows.push(row);
    }
  });

  const csvContent = csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `${file?.name || 'export'}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportAsTxt(data: any[]) {
  let textContent = '';
  const docTitle = `Extraction Results for: ${file?.name || 'document'}\n`;
  textContent += docTitle;
  textContent += '='.repeat(docTitle.length) + '\n\n';

  data.forEach((element) => {
    textContent += `[${element.type.toUpperCase()}] - Page ${element.page}\n`;
    if (element.label) {
      textContent += `Label: ${element.label}\n`;
    }
    if (element.value) {
      textContent += `Value: ${element.value}\n`;
    }
    if (element.type === 'field_group' && element.fields) {
      element.fields.forEach((field: { label: string; value: string }) => {
        textContent += `  - ${field.label}: ${field.value}\n`;
      });
    }
    if (element.type === 'table' && element.table_data) {
      textContent += 'Table Data:\n';
      textContent += `  Headers: ${element.table_data.headers.join(' | ')}\n`;
      element.table_data.rows.forEach((row: string[]) => {
        textContent += `  Row: ${row.join(' | ')}\n`;
      });
    }
    textContent += '---\n\n';
  });

  const blob = new Blob([textContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${file?.name || 'export'}.txt`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Renders a visual representation of the JSON schema in the UI.
 */
function displaySchema() {
  const schemaContainer = document.getElementById('schema-tab');
  schemaContainer.innerHTML = `
    <div class="schema-quick-start">
      <div class="schema-tabs">
        <button class="schema-tab-button active">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"></path></svg>
          Smart Suggestion
        </button>
        <button class="schema-tab-button">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>
          Prompt to Schema
        </button>
      </div>
      <div class="schema-fields">
        <h4>Schema for 'extracted_elements'</h4>
        <div class="schema-item">
          <span>extracted_elements</span>
          <span class="schema-type array">ARRAY</span>
        </div>
        <div class="schema-item nested">
          <span>(item)</span>
          <span class="schema-type object">OBJECT</span>
        </div>
        <div class="schema-item nested-2">
          <span>type</span>
          <span class="schema-type string">STRING</span>
        </div>
        <div class="schema-item nested-2">
          <span>label</span>
          <span class="schema-type string">STRING</span>
        </div>
         <div class="schema-item nested-2">
          <span>value</span>
          <span class="schema-type string">STRING</span>
        </div>
        <div class="schema-item nested-2">
          <span>page</span>
          <span class="schema-type integer">INTEGER</span>
        </div>
         <div class="schema-item nested-2">
          <span>bounding_box</span>
          <span class="schema-type object">OBJECT</span>
        </div>
      </div>
    </div>
  `;
}

// Display the schema on initial load
displaySchema();
